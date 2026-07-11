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

  const systemInstruction = `You are a cricket knowledge assistant. Your persona is a knowledgeable cricket coach.

Answer questions strictly using the provided context. Do NOT use outside knowledge or make assumptions.

Follow these strict output rules:
1. Writing Style: Write like a knowledgeable cricket coach, in a natural and conversational tone, rather than parsing a PDF.
2. No Raw Labels/Headings: Never output section headings or labels from the source documents such as "Definition:", "Why It Matters:", "Detailed Explanation:", "When It Is Used:", "Famous Examples:", "Pro Tip:", or "Fun Fact:". Strip these completely and weave the facts naturally into prose and don't include this "**" in your response.
3. Summarize & Paraphrase: Do not quote the document verbatim. Paraphrase and summarize while fully preserving the original meaning.
4. Coherent Synthesis: If multiple passages or details are retrieved, combine them into one smooth, coherent paragraph rather than listing them separately.
5. Conciseness: Keep the answer concise, between 2 to 5 sentences, unless the user explicitly requests more detail.
6. Markdown Bolding: Use markdown double-asterisks (e.g., **off drive**) to bold important cricket terms. Do not use other headings.
7. Strict Context Adherence: Never invent facts or include any information that is not directly supported by the provided context.
8. Fallback Answer: If the required information is not present in the provided context, you must respond EXACTLY with this phrase:
"I couldn't find information about this in the uploaded documents."

Do NOT include any source citations, file names, or page numbers (like "[Source: rules.pdf]") in your response text.`;

  const prompt = `Context:
${contextString}

Question:
${question}`;

  const modelsToTry = ['gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-1.5-pro'];
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
        let finalAnswer = text ? text.trim() : "I couldn't find information about this in the uploaded documents.";

        // Strip any residual bracketed sources or page markers that the model might have output
        finalAnswer = finalAnswer.replace(/\[\s*Source\s*:\s*[^\]]+\]/gi, '');
        finalAnswer = finalAnswer.replace(/\[\s*Page\s*\d+\s*\]/gi, '');

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

/**
 * Generates MCQs for specific history questions and answers.
 * 
 * @param {Array<Object>} chunks - The context chunks.
 * @param {Array<Object>} historyItems - History items containing { question, answer }.
 * @returns {Promise<Array<Object>>} Array of MCQs.
 */
export const generateQuizQuestionsForHistory = async (chunks, historyItems) => {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('Context chunks are required.');
  }
  if (!Array.isArray(historyItems) || historyItems.length === 0) {
    return [];
  }

  const contextString = optimizeContext(chunks);
  const historyString = historyItems.map((item, index) => {
    return `Item ${index + 1}:
Question Asked By User: ${item.question}
Correct Answer Provided By System: ${item.answer}`;
  }).join('\n\n');

  const systemInstruction = `You are a cricket trivia and quiz generator.

For each of the user's previously asked questions in the provided "User History", you must generate exactly one multiple-choice question (MCQ).
The field "questionText" in the generated MCQ MUST be identical to the user's question from the history.
Use the corresponding answer and the provided context to create 4 options, identifying the correct option, and writing a brief, helpful explanation of why the correct option is right.

For each question:
- The questionText MUST match the user's question.
- There must be exactly 4 options.
- Only one option (the correct answer) must be correct.
- The other three options must be plausible but incorrect distractors.
- Provide a brief, helpful explanation explaining why the correct option is right based on the context/answer.
- Do NOT use markdown bolding (double asterisks like **) in the questions, options, or explanations.

You MUST respond with a valid JSON array matching this structure:
[
  {
    "questionText": "User's exact question from history...",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctOptionIndex": 0, // Integer 0 to 3 matching the correct option in the options array
    "explanation": "Explanation here..."
  }
]`;

  const prompt = `Context:
${contextString}

User History:
${historyString}

Generate the MCQs in the required JSON format. You MUST generate exactly ${historyItems.length} questions, one for each question in the User History:`;

  const modelsToTry = ['gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-1.5-pro'];
  const genAI = getGenAI();
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`[API Call] Quiz Gen For History | Model: ${modelName} | Context: ~${contextString.length} chars | Questions: ${historyItems.length}`);

      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction,
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });

      // Wrap in retry and timeout (giving it up to 40 seconds because generating questions takes longer)
      const result = await withRetry(() => withTimeout(model.generateContent(prompt), 40000), 2);

      if (result && result.response) {
        const text = result.response.text();
        if (text && text.trim().length > 0) {
          const parsedQuestions = JSON.parse(text.trim());
          if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
            console.log(`[Success] Successfully generated ${parsedQuestions.length} quiz questions for history using ${modelName}`);
            return parsedQuestions.map(q => ({
              questionText: q.questionText.replace(/\*\*/g, ''),
              options: q.options.map(opt => opt.replace(/\*\*/g, '')),
              correctOptionIndex: Number(q.correctOptionIndex),
              explanation: q.explanation.replace(/\*\*/g, '')
            }));
          }
        }
      }
    } catch (error) {
      console.warn(`[Error] Quiz gen for history failed with model ${modelName}: ${error.message}`);
      lastError = error;
    }
  }

  console.error(`[Fallback] All models failed for history quiz generation. Error:`, lastError?.message);
  throw new Error(`Failed to generate history quiz: ${lastError ? lastError.message : 'Unknown error'}`);
};

/**
 * Generates MCQs purely based on PDF context chunks.
 * 
 * @param {Array<Object>} chunks - The context chunks.
 * @param {number} count - Number of questions to generate.
 * @returns {Promise<Array<Object>>} Array of MCQs.
 */
export const generateQuizQuestionsFromPDF = async (chunks, count) => {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('Context chunks are required.');
  }
  if (count <= 0) {
    return [];
  }

  const contextString = optimizeContext(chunks);

  const systemInstruction = `You are a cricket trivia and quiz generator.

Generate exactly ${count} multiple-choice questions (MCQs) based strictly on the provided context chunks.

For each question:
- The question must be answerable using only the provided context.
- There must be exactly 4 options.
- Only one option must be correct.
- Provide a brief, helpful explanation explaining why the correct option is right based on the context.
- Do NOT use markdown bolding (double asterisks like **) in the questions, options, or explanations.

You MUST respond with a valid JSON array matching this structure:
[
  {
    "questionText": "Question text here...",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctOptionIndex": 0,
    "explanation": "Explanation here..."
  }
]`;

  const prompt = `Context:
${contextString}

Generate the ${count} MCQs in the required JSON format:`;

  const modelsToTry = ['gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-1.5-pro'];
  const genAI = getGenAI();
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`[API Call] Quiz Gen From PDF | Model: ${modelName} | Context: ~${contextString.length} chars | Count: ${count}`);

      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction,
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });

      const result = await withRetry(() => withTimeout(model.generateContent(prompt), 40000), 2);

      if (result && result.response) {
        const text = result.response.text();
        if (text && text.trim().length > 0) {
          const parsedQuestions = JSON.parse(text.trim());
          if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
            console.log(`[Success] Successfully generated ${parsedQuestions.length} quiz questions from PDF using ${modelName}`);
            return parsedQuestions.map(q => ({
              questionText: q.questionText.replace(/\*\*/g, ''),
              options: q.options.map(opt => opt.replace(/\*\*/g, '')),
              correctOptionIndex: Number(q.correctOptionIndex),
              explanation: q.explanation.replace(/\*\*/g, '')
            }));
          }
        }
      }
    } catch (error) {
      console.warn(`[Error] Quiz gen from PDF failed with model ${modelName}: ${error.message}`);
      lastError = error;
    }
  }

  console.error(`[Fallback] All models failed for PDF quiz generation. Error:`, lastError?.message);
  throw new Error(`Failed to generate PDF quiz: ${lastError ? lastError.message : 'Unknown error'}`);
};
