import { GoogleGenerativeAI } from '@google/generative-ai';
import crypto from 'crypto';

let genAIInstance = null;

// Best practice: Simple bounded LRU cache to prevent memory leaks over time
const responseCache = new Map();
const MAX_CACHE_SIZE = 1000;

// Concurrency handling
const activeRequests = new Map(); // Track ongoing requests to prevent duplicates
let requestCount = 0;

const getGenAI = () => {
  if (!genAIInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not defined in the environment variables.');
    }
    genAIInstance = new GoogleGenerativeAI(apiKey);
  }
  return genAIInstance;
};

/**
 * Generate SHA-256 hash for cache keys.
 */
const generateHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Delay helper for exponential backoff
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wrap a promise with a timeout
 */
const withTimeout = (promise, ms) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${ms}ms`));
    }, ms);
    promise
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(reason => {
        clearTimeout(timer);
        reject(reason);
      });
  });
};

/**
 * Retries a function with exponential backoff on 429 / 503 errors.
 */
const withRetry = async (fn, maxRetries = 3) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      const errMsg = error.message.toLowerCase();
      const isRateLimit = errMsg.includes('429') || errMsg.includes('too many requests') || errMsg.includes('quota') || errMsg.includes('resource_exhausted');
      const isServerBusy = errMsg.includes('503') || errMsg.includes('service unavailable');
      
      if ((isRateLimit || isServerBusy) && attempt < maxRetries - 1) {
        attempt++;
        // Exponential backoff with jitter: (2^attempt * 1000) + random jitter (0-500ms)
        const backoffMs = (Math.pow(2, attempt) * 1000) + Math.random() * 500;
        console.warn(`[Gemini Retry] Attempt ${attempt} failed. Retrying in ${Math.round(backoffMs)}ms...`);
        await delay(backoffMs);
      } else {
        throw error;
      }
    }
  }
};

/**
 * Intelligently truncate and select context chunks.
 */
const optimizeContext = (chunks) => {
  // 1. Take only the top 3 most relevant chunks (Atlas returns them ordered by relevance)
  const topChunks = chunks.slice(0, 3).map(chunk => chunk.text);
  
  // 2. Join them safely
  return topChunks.join('\n\n');
};

/**
 * Generates a response constrained strictly to the provided search context.
 * 
 * @param {string} question - The user's question.
 * @param {Array<Object>} retrievedChunks - The array of retrieved text chunks from Vector Search.
 * @returns {Promise<string>} The generated answer text.
 */
export const generateAnswer = async (question, retrievedChunks) => {
  if (!question || typeof question !== 'string') {
    throw new Error('Question must be a non-empty string.');
  }
  if (!Array.isArray(retrievedChunks)) {
    throw new Error('Retrieved chunks must be an array.');
  }

  // Optimize context first
  const contextString = optimizeContext(retrievedChunks);

  // 1. Generate unique cache key based on BOTH question and context
  const cacheKey = generateHash(`${question.trim().toLowerCase()}|${contextString}`);
  
  // Check LRU Cache
  if (responseCache.has(cacheKey)) {
    console.log(`[Cache Hit] Serving response from memory.`);
    // Move to front (LRU behavior)
    const val = responseCache.get(cacheKey);
    responseCache.delete(cacheKey);
    responseCache.set(cacheKey, val);
    return val;
  }

  // 2. Prevent duplicate concurrent requests for the same context/question
  if (activeRequests.has(cacheKey)) {
    console.log(`[Queue] Duplicate request detected. Waiting for existing execution...`);
    return activeRequests.get(cacheKey);
  }

  // Create the request promise
  const executeRequest = async () => {
    requestCount++;
    const startTime = performance.now();
    
    const prompt = `You are a cricket knowledge assistant.
Answer using ONLY the provided context. If the exact answer is missing, state what the context says about the topic or say "I could not find this information in the uploaded documents."

Context:
${contextString}

Question:
${question}`;

    const modelsToTry = ['gemini-2.5-flash'];
    const genAI = getGenAI();
    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        console.log(`[API Call] (#${requestCount}) Model: ${modelName} | Prompt Size: ~${prompt.length} chars`);
        
        const model = genAI.getGenerativeModel({ model: modelName });
        
        // Wrap the generation in a retry block and a 15-second timeout
        const result = await withRetry(() => withTimeout(model.generateContent(prompt), 15000), 3);
        
        if (result && result.response) {
          const text = result.response.text();
          const finalAnswer = text ? text.trim() : 'I could not find this information in the uploaded documents.';
          
          const endTime = performance.now();
          console.log(`[Success] Answered in ${Math.round(endTime - startTime)}ms`);

          // Update LRU Cache
          if (responseCache.size >= MAX_CACHE_SIZE) {
            const firstKey = responseCache.keys().next().value;
            responseCache.delete(firstKey);
          }
          responseCache.set(cacheKey, finalAnswer);

          return finalAnswer;
        }
      } catch (error) {
        console.warn(`[Error] Model ${modelName} failed: ${error.message}`);
        lastError = error;
      }
    }

    // Graceful fallback if all retries fail
    console.error(`[Fallback] All retries exhausted. Providing fallback response. Error:`, lastError?.message);
    return 'I am currently experiencing high traffic and cannot process your request. Please try again in a few moments.';
  };

  // 3. Track the active request to prevent duplicates
  const requestPromise = executeRequest().finally(() => {
    activeRequests.delete(cacheKey);
  });
  
  activeRequests.set(cacheKey, requestPromise);
  
  return requestPromise;
};
