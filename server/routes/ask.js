import express from 'express';
import * as embeddingService from '../services/embeddingService.js';
import * as vectorSearchService from '../services/vectorSearchService.js';
import * as geminiService from '../services/geminiService.js';
import { cacheManager } from '../utils/cacheManager.js';

const router = express.Router();

// POST /ask endpoint
router.post('/', async (req, res) => {
  const { question, history } = req.body || {};

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

      // 6. Generate answer based on context using Gemini LLM
      console.log('Generating response with Gemini model...');
      const answer = await geminiService.generateAnswer(standaloneQuestion, expandedChunks);

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

    // 8. Send structured response
    return res.status(200).json(result);

  } catch (error) {
    console.error('Error in /ask route processing:', error);
    
    // Serve fallback message without caching it if generation failed due to traffic/quota
    if (error.message && error.message.includes('High traffic fallback triggered')) {
      return res.status(200).json({
        answer: 'I am currently experiencing high traffic and cannot process your request. Please try again in a few moments.',
        sources: []
      });
    }

    return res.status(500).json({ error: `Failed to answer the question: ${error.message}` });
  }
});

export default router;
