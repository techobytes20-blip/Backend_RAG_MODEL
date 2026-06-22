import express from 'express';
import * as embeddingService from '../services/embeddingService.js';
import * as vectorSearchService from '../services/vectorSearchService.js';
import * as geminiService from '../services/geminiService.js';

const router = express.Router();

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

    // 2. Perform Atlas Vector Search
    console.log('Searching MongoDB Atlas Vector Index...');
    const retrievedChunks = await vectorSearchService.searchSimilar(queryEmbedding, 5);

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
