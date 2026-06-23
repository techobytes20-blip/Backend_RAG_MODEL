import express from 'express';
import * as embeddingService from '../services/embeddingService.js';
import * as vectorSearchService from '../services/vectorSearchService.js';
import * as geminiService from '../services/geminiService.js';

const router = express.Router();

/**
 * Helper to ensure diverse chunks are selected for comparison queries.
 */
const selectDiverseChunks = (question, chunks, limit = 3) => {
  if (!chunks || chunks.length <= limit) return chunks;

  const stopWords = ['what', 'is', 'the', 'difference', 'between', 'and', 'compare', 'vs', 'versus', 'how', 'why', 'are', 'in', 'of', 'a', 'to', 'for', 'with', 'on'];
  const keywords = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));

  const selected = [];
  const selectedIds = new Set();

  // Pick the highest scoring chunk for each keyword
  for (const keyword of keywords) {
    if (selected.length >= limit) break;
    const matchingChunk = chunks.find(c => 
      !selectedIds.has(c.chunkId) && c.text.toLowerCase().includes(keyword)
    );
    if (matchingChunk) {
      selected.push(matchingChunk);
      selectedIds.add(matchingChunk.chunkId);
    }
  }

  // Fill the rest with the highest-scoring available chunks
  for (const chunk of chunks) {
    if (selected.length >= limit) break;
    if (!selectedIds.has(chunk.chunkId)) {
      selected.push(chunk);
      selectedIds.add(chunk.chunkId);
    }
  }

  return selected;
};

// POST /ask endpoint
router.post('/', async (req, res) => {
  const { question } = req.body;

  // Validate request
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'The "question" field is required and must be a non-empty string.' });
  }

  try {
    // 1. Generate embedding for the question
    console.log(`Generating embedding for question: "${question.trim()}"`);
    const queryEmbedding = await embeddingService.generateEmbedding(question.trim());

    // 2. Perform Atlas Vector Search (fetch 10 candidates for diversity)
    console.log('Searching MongoDB Atlas Vector Index...');
    const candidateChunks = await vectorSearchService.searchSimilar(queryEmbedding, 10);
    
    // Apply Keyword-Coverage Re-ranking to select exactly 3 chunks
    const retrievedChunks = selectDiverseChunks(question.trim(), candidateChunks, 3);

    // If no context chunks exist, return default message
    if (!retrievedChunks || retrievedChunks.length === 0) {
      return res.status(200).json({
        answer: 'I could not find this information in the uploaded documents.',
        sources: []
      });
    }

    // 3. Generate answer based on context using Gemini LLM
    console.log('Generating response with Gemini model...');
    const answer = await geminiService.generateAnswer(question.trim(), retrievedChunks);

    // 4. Map sources from retrieved chunks
    const sources = retrievedChunks.map((chunk) => ({
      filename: chunk.filename,
      chunkId: chunk.chunkId
    }));

    // 5. Send structured response
    return res.status(200).json({
      answer,
      sources
    });

  } catch (error) {
    console.error('Error in /ask route processing:', error);
    return res.status(500).json({ error: `Failed to answer the question: ${error.message}` });
  }
});

export default router;
