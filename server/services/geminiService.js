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
      const isServerBusy = errMsg.includes('503') || errMsg.includes('service unavailable') || errMsg.includes('500') || errMsg.includes('internal error') || errMsg.includes('timeout');

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
 * Intelligently formats context chunks, adding document name and page number headers.
 */
const optimizeContext = (chunks) => {
  return chunks.map(chunk => {
    const pageLabel = chunk.pageNumber ? ` (Page ${chunk.pageNumber})` : '';
    return `[Source: ${chunk.filename}${pageLabel}]\n${chunk.text}`;
  }).join('\n\n---\n\n');
};

/**
 * Reformulates a conversational follow-up question into a search-optimized standalone question
 * using the dialogue history.
 * 
 * @param {string} question - The user's follow-up question.
 * @param {Array<Object>} history - The history of messages in the dialogue.
 * @returns {Promise<string>} The rewritten standalone question.
 */
export const generateStandaloneQuery = async (question, history) => {
  if (!history || !Array.isArray(history) || history.length === 0) {
    return question;
  }

  try {
    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: 'You are an expert search query reformulator. Your job is to take a dialogue history and a new follow-up question, and rewrite it into a single standalone search query. The standalone query should completely resolve references like "he", "she", "it", "they", "that", "those", etc. into actual context terms from the history. DO NOT answer the question. Output ONLY the rewritten standalone question.'
    });

    const conversationHistoryStr = history
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');

    const prompt = `Dialogue History:
${conversationHistoryStr}

Follow-up Question: ${question}

Standalone Query:`;

    const result = await withRetry(() => withTimeout(model.generateContent(prompt), 10000), 2);
    if (result && result.response) {
      const text = result.response.text();
      if (text && text.trim().length > 0) {
        const rewritten = text.trim();
        console.log(`[Query Rewriter] Original: "${question}" -> Rewritten Standalone: "${rewritten}"`);
        return rewritten;
      }
    }
  } catch (error) {
    console.warn('[Query Rewriter Warning] Failed to rewrite query, falling back to original:', error.message);
  }
  return question;
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

Answer using ONLY the provided context. Do NOT include any source citations, file names, or page numbers in your response text (e.g., do not write things like "[Source: rules.pdf]" or mention document names). The sources will be shown separately to the user by the application.

You may combine, compare, summarize, and synthesize information from multiple context sections to answer the user's question.

For comparison questions, identify the relevant concepts from the context and explain their similarities or differences in a clear and concise manner.

Do not use outside knowledge or make assumptions.

Do not use markdown bolding (double asterisks like **) in your response. Present headings or labels as plain text followed by a colon (e.g., "Category: Batting" instead of "**Category:** Batting").

Do NOT include a "Detailed Explanation" section in your response. Ensure each subheading starts on a new line so that after a full stop at the end of a section, the next subheading begins on the next line.

If the required information is not present in the provided context, respond exactly:

"I could not find this information in the uploaded documents."`;

  const prompt = `Context:
${contextString}

Question:
${question}`;

  const modelsToTry = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.1-pro-preview'];
  const genAI = getGenAI();
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`[API Call] (#${requestCount}) Model: ${modelName} | Prompt Size: ~${prompt.length} chars`);

      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction
      });

      // Wrap the generation in a retry block and a 30-second timeout
      const result = await withRetry(() => withTimeout(model.generateContent(prompt), 30000), 3);

      if (result && result.response) {
        const text = result.response.text();
        let finalAnswer = text ? text.trim() : 'I could not find this information in the uploaded documents.';

        // Remove any markdown bolding symbols (**)
        finalAnswer = finalAnswer.replace(/\*\*/g, '');

        // Strip any residual bracketed sources or page markers that the model might have output
        finalAnswer = finalAnswer.replace(/\[\s*Source\s*:\s*[^\]]+\]/gi, '');
        finalAnswer = finalAnswer.replace(/\[\s*Page\s*\d+\s*\]/gi, '');
        
        // Programmatically strip 'Detailed Explanation' since LLMs sometimes copy it from context ignoring negative constraints
        finalAnswer = finalAnswer.replace(/\n*\s*Detailed Explanation:.*?(?=\n[A-Za-z ]+:|$)/gs, '');

        // Clean up redundant spaces but preserve newlines
        finalAnswer = finalAnswer.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();

        const endTime = performance.now();
        console.log(`[Success] Answered in ${Math.round(endTime - startTime)}ms`);

        return finalAnswer;
      }
    } catch (error) {
      console.warn(`[Error] Model ${modelName} failed: ${error.message}`);
      lastError = error;
    }
  }

  // Throw an error so the cache manager doesn't cache the fallback message
  console.error(`[Fallback] All retries exhausted. Error:`, lastError?.message);
  throw new Error('All retries exhausted. High traffic fallback triggered.');
};
