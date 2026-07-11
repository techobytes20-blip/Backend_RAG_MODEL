import crypto from 'crypto';
import QueryCache from '../models/QueryCache.js';
import QuizQuestionCache from '../models/QuizQuestionCache.js';
import * as embeddingService from '../services/embeddingService.js';

const cosineSimilarity = (vecA, vecB) => {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

class CacheManager {
  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.activeRequests = new Map();
  }

  generateHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Returns a cached value or executes the fetch function, caching its result.
   * Also prevents identical concurrent requests from running twice.
   * Uses both in-memory (L1) and MongoDB (L2) cache tiers.
   * 
   * @param {string} key - The string key to hash (e.g., user question)
   * @param {Function} fetchFunction - Async function returning the data to cache
   * @returns {Promise<any>}
   */
  async getCachedOrFetch(key, fetchFunction) {
    const hashKey = this.generateHash(key);

    // 1. Check L1 memory cache (fastest)
    if (this.cache.has(hashKey)) {
      console.log(`[Cache L1 Hit] Serving response from memory.`);
      // Move to front (LRU behavior)
      const val = this.cache.get(hashKey);
      this.cache.delete(hashKey);
      this.cache.set(hashKey, val);
      return val;
    }

    // 2. Prevent duplicate concurrent requests
    if (this.activeRequests.has(hashKey)) {
      console.log(`[Queue] Duplicate request detected. Waiting for existing execution...`);
      return this.activeRequests.get(hashKey);
    }

    // 3. Execute request and track it
    const requestPromise = (async () => {
      try {
        // A. Check L2 MongoDB Exact Match
        try {
          const exactMatch = await QueryCache.findOne({ hash: hashKey });
          if (exactMatch) {
            console.log(`[Cache L2 Hit] Serving exact match from MongoDB.`);
            const result = {
              answer: exactMatch.answer,
              sources: exactMatch.sources.map(s => ({
                filename: s.filename,
                chunkId: s.chunkId
              }))
            };
            this.updateMemoryCache(hashKey, result);
            return result;
          }
        } catch (dbError) {
          console.warn(`[Cache L2 Error] MongoDB exact match query failed: ${dbError.message}`);
        }

        // B. Check L2 MongoDB Semantic Match
        let queryEmbedding = null;
        try {
          console.log(`[Cache L2] Generating embedding to check semantic cache...`);
          queryEmbedding = await embeddingService.generateEmbedding(key);
          
          const pipeline = [
            {
              $vectorSearch: {
                index: 'qa_vector_index',
                path: 'embedding',
                queryVector: queryEmbedding,
                numCandidates: 10,
                limit: 1
              }
            },
            {
              $project: {
                question: 1,
                answer: 1,
                sources: 1,
                score: { $meta: 'searchScore' }
              }
            }
          ];

          let results = [];
          try {
            results = await QueryCache.aggregate(pipeline);
          } catch (err) {
            console.warn(`[Cache L2 Warning] Atlas Vector Search failed, falling back to JS similarity matching: ${err.message}`);
          }

          if (results && results.length > 0) {
            const match = results[0];
            // Threshold of 0.95 search score corresponds to high cosine similarity
            if (match.score >= 0.95) {
              console.log(`[Cache L2 Hit] Semantic match found with Atlas search (score ${match.score.toFixed(4)}): "${match.question}"`);
              const result = {
                answer: match.answer,
                sources: match.sources.map(s => ({
                  filename: s.filename,
                  chunkId: s.chunkId
                }))
              };
              this.updateMemoryCache(hashKey, result);
              return result;
            } else {
              console.log(`[Cache L2 Miss] Closest Atlas match was "${match.question}" with score ${match.score.toFixed(4)} (below threshold of 0.95)`);
            }
          }

          // Fallback: JS-based Cosine Similarity Search
          if (!results || results.length === 0) {
            console.log(`[Cache L2] Performing JS-based semantic cache search...`);
            const allCached = await QueryCache.find({}, 'question embedding answer sources').limit(200);
            if (allCached && allCached.length > 0) {
              let bestMatch = null;
              let bestScore = -1;
              for (const entry of allCached) {
                if (entry.embedding && entry.embedding.length > 0) {
                  const score = cosineSimilarity(queryEmbedding, entry.embedding);
                  if (score > bestScore) {
                    bestScore = score;
                    bestMatch = entry;
                  }
                }
              }

              if (bestMatch && bestScore >= 0.90) {
                console.log(`[Cache L2 Hit] Semantic match found with JS similarity (score ${bestScore.toFixed(4)}): "${bestMatch.question}"`);
                const result = {
                  answer: bestMatch.answer,
                  sources: bestMatch.sources.map(s => ({
                    filename: s.filename,
                    chunkId: s.chunkId
                  }))
                };
                this.updateMemoryCache(hashKey, result);
                return result;
              } else if (bestMatch) {
                console.log(`[Cache L2 Miss] Closest JS match was "${bestMatch.question}" with score ${bestScore.toFixed(4)} (below threshold of 0.90)`);
              }
            }
          }
        } catch (error) {
          console.warn(`[Cache L2 Warning] Semantic search failed completely: ${error.message}`);
        }

        // C. Cache Miss: Execute the fetch function (RAG pipeline + Gemini LLM)
        const result = await fetchFunction();

        // D. Save to L1 memory cache
        this.updateMemoryCache(hashKey, result);

        // E. Save to L2 MongoDB cache
        try {
          if (result && result.answer) {
            // Generate embedding if it wasn't generated during semantic check
            if (!queryEmbedding) {
              queryEmbedding = await embeddingService.generateEmbedding(key);
            }

            await QueryCache.create({
              hash: hashKey,
              question: key,
              embedding: queryEmbedding,
              answer: result.answer,
              sources: result.sources
            });
            console.log(`[Cache L2 Store] Saved Q&A pair in MongoDB.`);
          }
        } catch (dbError) {
          console.warn(`[Cache L2 Error] Failed to store cache entry in MongoDB: ${dbError.message}`);
        }

        return result;
      } finally {
        // Clean up the active request map whether it succeeded or failed
        this.activeRequests.delete(hashKey);
      }
    })();

    this.activeRequests.set(hashKey, requestPromise);
    return requestPromise;
  }

  updateMemoryCache(hashKey, result) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(hashKey, result);
  }

  /**
   * Check if MCQ is cached for a specific question text.
   * Uses both exact match and semantic match.
   */
  async getCachedMCQ(questionText) {
    if (!questionText || typeof questionText !== 'string') return null;
    const hashKey = this.generateHash(questionText.trim().toLowerCase());
    
    // 1. Exact match check
    try {
      const exactMatch = await QuizQuestionCache.findOne({ hash: hashKey });
      if (exactMatch) {
        console.log(`[MCQ Cache Hit] Exact match found for question: "${questionText}"`);
        return exactMatch.mcq;
      }
    } catch (err) {
      console.warn(`[MCQ Cache L2 Error] Exact match check failed: ${err.message}`);
    }

    // 2. Semantic match check using JS-based Cosine Similarity
    try {
      const queryEmbedding = await embeddingService.generateEmbedding(questionText);
      const allCached = await QuizQuestionCache.find({}, 'question embedding mcq').limit(200);
      if (allCached && allCached.length > 0) {
        let bestMatch = null;
        let bestScore = -1;
        for (const entry of allCached) {
          if (entry.embedding && entry.embedding.length > 0) {
            const score = cosineSimilarity(queryEmbedding, entry.embedding);
            if (score > bestScore) {
              bestScore = score;
              bestMatch = entry;
            }
          }
        }

        if (bestMatch && bestScore >= 0.90) {
          console.log(`[MCQ Cache Hit] Semantic match found (score ${bestScore.toFixed(4)}): "${bestMatch.question}" for query "${questionText}"`);
          return bestMatch.mcq;
        }
      }
    } catch (error) {
      console.warn(`[MCQ Cache Warning] Semantic search failed: ${error.message}`);
    }

    return null;
  }

  /**
   * Save a generated MCQ to QuizQuestionCache
   */
  async saveMCQToCache(questionText, mcq) {
    try {
      if (!questionText || !mcq) return;
      const hashKey = this.generateHash(questionText.trim().toLowerCase());
      const queryEmbedding = await embeddingService.generateEmbedding(questionText);

      // Check if it already exists to avoid duplicate key errors
      const exists = await QuizQuestionCache.findOne({ hash: hashKey });
      if (!exists) {
        await QuizQuestionCache.create({
          hash: hashKey,
          question: questionText,
          embedding: queryEmbedding,
          mcq: mcq
        });
        console.log(`[MCQ Cache Store] Saved MCQ in MongoDB for: "${questionText}"`);
      }
    } catch (dbError) {
      console.warn(`[MCQ Cache Store Error] Failed to cache MCQ: ${dbError.message}`);
    }
  }

  /**
   * Clears both in-memory cache and MongoDB cached Q&As/MCQs.
   */
  async clear() {
    try {
      this.cache.clear();
      await QueryCache.deleteMany({});
      await QuizQuestionCache.deleteMany({});
      console.log('[Cache Cleared] Cleared memory, MongoDB Q&A, and MCQ cache.');
    } catch (error) {
      console.error('[Cache Clear Error] Failed to purge MongoDB cache:', error);
    }
  }
}

// Export a singleton instance
export const cacheManager = new CacheManager(1000);

