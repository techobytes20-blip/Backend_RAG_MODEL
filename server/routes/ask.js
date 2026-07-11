import express from 'express';
import * as embeddingService from '../services/embeddingService.js';
import * as vectorSearchService from '../services/vectorSearchService.js';
import * as geminiService from '../services/geminiService.js';
import { cacheManager } from '../utils/cacheManager.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import UserHistory from '../models/UserHistory.js';
import Chunk from '../models/Chunk.js';

const router = express.Router();

// GET /ask/history endpoint
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const history = await UserHistory.find({ userId: req.user._id })
      .sort({ timestamp: 1 }) // Chronological order
      .lean();

    // Group by sessionId in memory
    const sessionsMap = {};
    const legacySessionId = 'session_legacy';
    
    history.forEach(item => {
      // If sessionId is missing, group under a fallback legacy session
      const sId = item.sessionId || legacySessionId;
      if (!sessionsMap[sId]) {
        sessionsMap[sId] = {
          sessionId: sId,
          timestamp: item.timestamp,
          firstQuestion: item.question,
          messages: []
        };
      }
      sessionsMap[sId].messages.push({
        _id: item._id,
        question: item.question,
        answer: item.answer,
        timestamp: item.timestamp
      });
    });

    // Convert map to list and sort sessions by timestamp descending (newest session first)
    const sessionsList = Object.values(sessionsMap).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.status(200).json(sessionsList);
  } catch (error) {
    console.error('Error fetching chat history:', error);
    return res.status(500).json({ error: `Failed to fetch chat history: ${error.message}` });
  }
});

// POST /ask endpoint
router.post('/', authMiddleware, async (req, res) => {
  const { question, history, sessionId } = req.body || {};

  // Validate request
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'The "question" field is required and must be a non-empty string.' });
  }

  try {
    // 1. Resolve conversational history to generate a standalone query
    const standaloneQuestion = await geminiService.generateStandaloneQuery(question.trim(), history);
    const normalizedQuestion = standaloneQuestion.trim().toLowerCase();

    const result = await cacheManager.getCachedOrFetch(normalizedQuestion, async () => {
      // 2. Generate embedding for the standalone question
      console.log(`Generating embedding for question: "${standaloneQuestion}"`);
      const queryEmbedding = await embeddingService.generateEmbedding(standaloneQuestion);

      // 3. Perform Atlas Vector Search (fetch 10 candidates for hybrid reranking)
      console.log('Searching MongoDB Atlas Vector Index...');
      const candidateChunks = await vectorSearchService.searchSimilar(queryEmbedding, 10);

      // If no context chunks exist, return default message
      if (!candidateChunks || candidateChunks.length === 0) {
        return {
          answer: 'I could not find this information in the uploaded documents.',
          sources: []
        };
      }

      // 4. Apply Keyword-Coverage Hybrid Reranking to select top 3 chunks
      const retrievedChunks = vectorSearchService.rerankChunks(standaloneQuestion, candidateChunks, 3);

      console.log("Reranked Matches:");
      retrievedChunks.forEach((chunk, index) => {
        console.log(`Match ${index + 1}: ${chunk.filename} (Page ${chunk.pageNumber || 'N/A'}, ID ${chunk.chunkId}) - Score: ${(chunk.score || 0).toFixed(4)}`);
      });

      // 5. Apply Contextual Window Retrieval (Parent-Child) to expand retrieved chunks into coherent paragraphs
      console.log('Expanding context window for reranked chunks...');
      const expandedChunks = await vectorSearchService.expandChunksContext(retrievedChunks);

      // 6. Generate answer based on context using Gemini LLM, returning a high-traffic fallback if rate limited
      console.log('Generating response with Gemini model...');
      let answer;
      try {
        answer = await geminiService.generateAnswer(standaloneQuestion, expandedChunks);
      } catch (error) {
        if (error.message && error.message.includes('High traffic fallback triggered')) {
          answer = 'I am currently experiencing high traffic and cannot process your request. Please try again in a few moments.';
        } else {
          throw error;
        }
      }

      // 7. Map sources from retrieved chunks (citing actual matched pages)
      const sources = retrievedChunks.map((chunk) => ({
        filename: chunk.filename,
        chunkId: chunk.chunkId,
        pageNumber: chunk.pageNumber || null
      }));

      return {
        answer,
        sources
      };
    });

    // 8. Track user search history
    try {
      let chunkIds = [];
      if (result.sources && result.sources.length > 0) {
        const queryMatches = result.sources.map(s => ({ filename: s.filename, chunkId: s.chunkId }));
        const matchingChunks = await Chunk.find({ $or: queryMatches }, '_id').lean();
        chunkIds = matchingChunks.map(c => c._id);
      }

      const historyItem = await UserHistory.create({
        userId: req.user._id,
        sessionId: sessionId || null,
        question: question.trim(),
        answer: result.answer,
        chunks: chunkIds
      });
      console.log(`[History] Saved history for user: ${req.user._id} and query: "${question.trim()}"`);
      result.historyId = historyItem._id;
    } catch (dbError) {
      console.error('[History Error] Failed to log user query to history:', dbError.message);
    }

    // 9. Send structured response
    return res.status(200).json(result);

  } catch (error) {
    console.error('Error in /ask route processing:', error);
    return res.status(500).json({ error: `Failed to answer the question: ${error.message}` });
  }
});

export default router;
