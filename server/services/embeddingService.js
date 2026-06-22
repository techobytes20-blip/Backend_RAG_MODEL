import { GoogleGenerativeAI } from '@google/generative-ai';

let genAIInstance = null;

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
 * Generates an embedding vector for a single text chunk.
 * Uses the gemini-embedding-001 model (configured to 768 dimensions).
 * 
 * @param {string} text - The input text chunk.
 * @returns {Promise<number[]>} The vector embedding values.
 */
export const generateEmbedding = async (text) => {
  if (!text || typeof text !== 'string') {
    throw new Error('Input text must be a non-empty string.');
  }

  try {
    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
    const result = await model.embedContent({
      content: { parts: [{ text: text }] },
      outputDimensionality: 768
    });
    
    if (!result.embedding || !result.embedding.values) {
      throw new Error('Empty embedding received from Gemini API.');
    }
    
    return result.embedding.values;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw new Error(`Embedding API Failure: ${error.message}`);
  }
};

/**
 * Generates embeddings for a batch of text chunks sequentially
 * to prevent API rate limits (HTTP 429).
 * 
 * @param {string[]} texts - Array of text chunks to embed.
 * @returns {Promise<number[][]>} Array of vector embeddings.
 */
export const generateEmbeddingsBatch = async (texts) => {
  if (!Array.isArray(texts)) {
    throw new Error('Input must be an array of strings.');
  }

  const embeddings = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    try {
      const embedding = await generateEmbedding(text);
      embeddings.push(embedding);
      
      // Delay slightly between requests (100ms) to respect free-tier rate limits
      if (i < texts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      throw new Error(`Failed batch embedding at index ${i}: ${error.message}`);
    }
  }
  return embeddings;
};
