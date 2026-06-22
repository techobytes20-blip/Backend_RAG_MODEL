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

  // Format retrieved chunks into context string
  const contextString = retrievedChunks
    .map((chunk) => `[Document: ${chunk.filename}, Chunk ID: ${chunk.chunkId}]\n${chunk.text}`)
    .join('\n\n');

  // Smart context-constrained prompt template
  const prompt = `You are a cricket knowledge assistant.
Answer the question using ONLY the provided context. 

If the context contains information about the term or concept mentioned in the question (e.g. its definition, how it is bowled, or how it behaves) but does not explicitly answer the specific question (e.g., "how to play" it), you should explain what the context does say about the concept, while making it clear that explicit instructions for the requested action are not present in the documents.

If the context does not contain any relevant information about the concept at all, reply:
"I could not find this information in the uploaded documents."

Context:
${contextString}

Question:
${question}`;

  const modelsToTry = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-2.5-pro'
  ];

  const genAI = getGenAI();
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`Attempting answer generation with model: ${modelName}`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      
      if (result && result.response) {
        const text = result.response.text();
        return text ? text.trim() : 'I could not find this information in the uploaded documents.';
      }
    } catch (error) {
      console.warn(`⚠️ Model ${modelName} failed: ${error.message}`);
      lastError = error;
    }
  }

  // If all models in the fallback chain fail, raise a descriptive error
  console.error('All model attempts failed:', lastError);
  const errMsg = lastError ? lastError.message : 'Unknown error';
  
  if (errMsg.includes('429') || errMsg.toLowerCase().includes('quota')) {
    throw new Error('Gemini API quota exceeded. Please wait a few moments or switch to a paid API key tier.');
  }
  
  throw new Error(`Gemini LLM API Failure: ${errMsg}`);
};
