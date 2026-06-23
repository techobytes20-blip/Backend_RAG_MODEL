import { GoogleGenerativeAI } from '@google/generative-ai';

let genAIInstance = null;
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

  requestCount++;
  const startTime = performance.now();
  
  const systemInstruction = `You are a cricket knowledge assistant.
Answer using ONLY the provided context. If the exact answer is missing, state what the context says about the topic or say "I could not find this information in the uploaded documents."`;

  const prompt = `Context:
${contextString}

Question:
${question}`;

  const modelsToTry = ['gemini-2.5-flash'];
  const genAI = getGenAI();
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`[API Call] (#${requestCount}) Model: ${modelName} | Prompt Size: ~${prompt.length} chars`);
      
      const model = genAI.getGenerativeModel({ 
        model: modelName,
        systemInstruction: systemInstruction
      });
      
      // Wrap the generation in a retry block and a 15-second timeout
      const result = await withRetry(() => withTimeout(model.generateContent(prompt), 15000), 3);
      
      if (result && result.response) {
        const text = result.response.text();
        const finalAnswer = text ? text.trim() : 'I could not find this information in the uploaded documents.';
        
        const endTime = performance.now();
        console.log(`[Success] Answered in ${Math.round(endTime - startTime)}ms`);

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
