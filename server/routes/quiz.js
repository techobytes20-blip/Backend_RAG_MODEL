import express from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import UserHistory from '../models/UserHistory.js';
import Chunk from '../models/Chunk.js';
import Quiz from '../models/Quiz.js';
import QuizAttempt from '../models/QuizAttempt.js';
import * as geminiService from '../services/geminiService.js';
import { cacheManager } from '../utils/cacheManager.js';
import QuizQuestionCache from '../models/QuizQuestionCache.js';

const router = express.Router();

// GET /quiz/active
// Retrieves or generates the user's active personalized quiz (always 10 questions)
router.get('/active', authMiddleware, async (req, res) => {
  try {
    // 1. Fetch user's recent history (up to last 10 entries)
    const recentHistory = await UserHistory.find({ userId: req.user._id })
      .sort({ timestamp: -1 })
      .limit(10)
      .lean();

    const seenQuestions = new Set();
    const quizSourceQuestions = [];

    // Prioritize user's own history
    for (const item of recentHistory) {
      const qNorm = item.question.trim().toLowerCase();
      if (!seenQuestions.has(qNorm)) {
        seenQuestions.add(qNorm);
        quizSourceQuestions.push({
          question: item.question.trim(),
          answer: item.answer,
          historyId: item._id,
          isPreGeneratedMCQ: false
        });
      }
    }

    // Fill up to 10 questions using global history (other users)
    if (quizSourceQuestions.length < 10) {
      const needed = 10 - quizSourceQuestions.length;
      const globalHistory = await UserHistory.find({
        userId: { $ne: req.user._id },
        question: { $nin: Array.from(seenQuestions) }
      })
      .sort({ timestamp: -1 })
      .limit(needed)
      .lean();

      for (const item of globalHistory) {
        const qNorm = item.question.trim().toLowerCase();
        if (!seenQuestions.has(qNorm)) {
          seenQuestions.add(qNorm);
          quizSourceQuestions.push({
            question: item.question.trim(),
            answer: item.answer,
            historyId: item._id,
            isPreGeneratedMCQ: false
          });
        }
      }
    }

    // Fill up to 10 using general cached MCQs
    if (quizSourceQuestions.length < 10) {
      const needed = 10 - quizSourceQuestions.length;
      const cachedMCQs = await QuizQuestionCache.find({
        question: { $nin: Array.from(seenQuestions) }
      })
      .limit(needed)
      .lean();

      for (const item of cachedMCQs) {
        const qNorm = item.question.trim().toLowerCase();
        if (!seenQuestions.has(qNorm)) {
          seenQuestions.add(qNorm);
          quizSourceQuestions.push({
            question: item.question.trim(),
            isPreGeneratedMCQ: true,
            mcq: item.mcq
          });
        }
      }
    }

    const historyIds = quizSourceQuestions
      .map(q => q.historyId)
      .filter(Boolean);

    // 2. Check if the user already has an active quiz
    const activeQuiz = await Quiz.findOne({ userId: req.user._id, isActive: true });

    if (activeQuiz) {
      // Check if the history used for the active quiz is identical to current recent history
      const recentHistoryIdsStr = historyIds.map(id => id.toString()).sort();
      const quizHistoryIdsStr = activeQuiz.basedOnHistoryIds.map(id => id.toString()).sort();
      
      const isHistoryIdentical = 
        recentHistoryIdsStr.length === quizHistoryIdsStr.length && 
        recentHistoryIdsStr.every((val, index) => val === quizHistoryIdsStr[index]);

      if (isHistoryIdentical) {
        // Safe check: Ensure there are exactly 10 questions in the quiz
        if (activeQuiz.questions && activeQuiz.questions.length === 10) {
          console.log('[Quiz API] History unchanged. Serving cached quiz from DB.');
          const clientQuestions = activeQuiz.questions.map(q => ({
            _id: q._id,
            questionText: q.questionText,
            options: q.options
          }));
          return res.status(200).json({
            quizId: activeQuiz._id,
            questions: clientQuestions,
            cached: true
          });
        }
      }
    }

    // 3. Either no active quiz exists or history has changed: generate a new quiz
    console.log('[Quiz API] History updated or quiz missing. Generating a new quiz...');

    const numToGenerateFromPDF = 10 - quizSourceQuestions.length;

    // Fetch chunk details for context
    const allHistoryUsed = [...recentHistory];
    if (recentHistory.length < 10) {
      const extraGlobal = await UserHistory.find({ userId: { $ne: req.user._id } }).sort({ timestamp: -1 }).limit(10).lean();
      allHistoryUsed.push(...extraGlobal);
    }
    const chunkIds = [...new Set(allHistoryUsed.flatMap(h => h.chunks || []).map(id => id.toString()))];
    let chunks = await Chunk.find({ _id: { $in: chunkIds } }, 'filename pageNumber text').lean();

    if (chunks.length === 0) {
      console.warn('[Quiz API] No historical chunks found, retrieving latest document chunks as fallback...');
      chunks = await Chunk.find({}).sort({ createdAt: -1 }).limit(10).lean();
    }

    if (chunks.length === 0 && numToGenerateFromPDF > 0) {
      return res.status(400).json({
        error: 'No document content available in system to generate quiz. Please upload a document first.'
      });
    }

    let finalQuestions = [];
    const premiumFallbackQuestions = [
      {
        questionText: "Which player has scored the most runs in international cricket?",
        options: ["Ricky Ponting", "Sachin Tendulkar", "Virat Kohli", "Jacques Kallis"],
        correctOptionIndex: 1,
        explanation: "Sachin Tendulkar holds the record for the most runs in international cricket."
      },
      {
        questionText: "How many legal deliveries are bowled in a standard over?",
        options: ["4", "5", "6", "8"],
        correctOptionIndex: 2,
        explanation: "A standard over in cricket consists of 6 legal deliveries."
      },
      {
        questionText: "Which country won the inaugural ICC Men's T20 World Cup in 2007?",
        options: ["Pakistan", "India", "Australia", "West Indies"],
        correctOptionIndex: 1,
        explanation: "India won the first T20 World Cup by defeating Pakistan in the final in 2007."
      },
      {
        questionText: "What is the length of a standard cricket pitch between the wickets?",
        options: ["20 yards", "22 yards", "24 yards", "26 yards"],
        correctOptionIndex: 1,
        explanation: "The standard length of a cricket pitch is 22 yards."
      },
      {
        questionText: "Which bowler has taken the most wickets in Test cricket history?",
        options: ["Shane Warne", "Anil Kumble", "Muttiah Muralitharan", "James Anderson"],
        correctOptionIndex: 2,
        explanation: "Muttiah Muralitharan of Sri Lanka has taken 800 wickets in Test cricket."
      },
      {
        questionText: "Who is known as the 'Don' of cricket, having a Test batting average of 99.94?",
        options: ["Sir Don Bradman", "Sir Garfield Sobers", "Sir Viv Richards", "Sir Jack Hobbs"],
        correctOptionIndex: 0,
        explanation: "Sir Don Bradman finished his Test career with a legendary average of 99.94."
      },
      {
        questionText: "What does the abbreviation LBW stand for in cricket?",
        options: ["Leg Before Wicket", "Leg Behind Wicket", "Line Boundary Wicket", "Leg Beyond Width"],
        correctOptionIndex: 0,
        explanation: "LBW stands for Leg Before Wicket, which is a method of dismissing a batsman."
      },
      {
        questionText: "How many fielders are allowed outside the 30-yard circle during the first Powerplay in an ODI?",
        options: ["2", "3", "4", "5"],
        correctOptionIndex: 0,
        explanation: "Only 2 fielders are allowed outside the 30-yard circle during the first 10 overs of an ODI match."
      },
      {
        questionText: "What color is the ball used in day-night Test matches?",
        options: ["Red", "White", "Pink", "Orange"],
        correctOptionIndex: 2,
        explanation: "Pink balls are used in day-night Test matches for better visibility under floodlights."
      },
      {
        questionText: "Which cricket ground is popularly known as the 'Home of Cricket'?",
        options: ["The MCG", "Lord's", "The Oval", "Eden Gardens"],
        correctOptionIndex: 1,
        explanation: "Lord's Cricket Ground in London is widely referred to as the 'Home of Cricket'."
      }
    ];

    try {
      // 1. Check MCQ Cache for history questions
      for (const item of quizSourceQuestions) {
        if (!item.isPreGeneratedMCQ) {
          const cached = await cacheManager.getCachedMCQ(item.question);
          if (cached) {
            item.isPreGeneratedMCQ = true;
            item.mcq = cached;
          }
        }
      }

      const historyMisses = quizSourceQuestions.filter(q => !q.isPreGeneratedMCQ);

      let generatedHistoryMCQs = [];
      if (historyMisses.length > 0) {
        generatedHistoryMCQs = await geminiService.generateQuizQuestionsForHistory(chunks, historyMisses);
        for (const mcq of generatedHistoryMCQs) {
          const match = historyMisses.find(m => m.question.trim().toLowerCase() === mcq.questionText.trim().toLowerCase());
          const key = match ? match.question : mcq.questionText;
          await cacheManager.saveMCQToCache(key, mcq);
        }
      }

      let generatedPDFMCQs = [];
      if (numToGenerateFromPDF > 0) {
        generatedPDFMCQs = await geminiService.generateQuizQuestionsFromPDF(chunks, numToGenerateFromPDF);
        for (const mcq of generatedPDFMCQs) {
          await cacheManager.saveMCQToCache(mcq.questionText, mcq);
        }
      }

      // Assemble final questions list
      for (const item of quizSourceQuestions) {
        if (item.isPreGeneratedMCQ && item.mcq) {
          finalQuestions.push(item.mcq);
        }
      }
      finalQuestions.push(...generatedHistoryMCQs);
      finalQuestions.push(...generatedPDFMCQs);

    } catch (llmError) {
      console.warn('[Quiz API Warning] LLM generation failed. Using premium fallback cricket quiz questions:', llmError.message);
      
      // Fallback: Use whatever we got from the cache, then pad with fallback questions
      for (const item of quizSourceQuestions) {
        if (item.isPreGeneratedMCQ && item.mcq) {
          finalQuestions.push(item.mcq);
        }
      }
    }

    // Ensure exactly 10 questions are returned
    finalQuestions = finalQuestions.slice(0, 10);
    if (finalQuestions.length < 10) {
      for (const fallback of premiumFallbackQuestions) {
        if (finalQuestions.length >= 10) break;
        const isDuplicate = finalQuestions.some(q => q.questionText.trim().toLowerCase() === fallback.questionText.trim().toLowerCase());
        if (!isDuplicate) {
          finalQuestions.push(fallback);
        }
      }
    }

    // Deactivate previous quizzes
    await Quiz.updateMany({ userId: req.user._id }, { isActive: false });

    // Store new Quiz in database
    const newQuiz = await Quiz.create({
      userId: req.user._id,
      questions: finalQuestions,
      basedOnHistoryIds: historyIds,
      isActive: true
    });

    const clientQuestions = newQuiz.questions.map(q => ({
      _id: q._id,
      questionText: q.questionText,
      options: q.options
    }));

    return res.status(200).json({
      quizId: newQuiz._id,
      questions: clientQuestions,
      cached: false
    });

  } catch (error) {
    console.error('Error generating active quiz:', error);
    return res.status(500).json({ error: `Failed to retrieve active quiz: ${error.message}` });
  }
});

// POST /quiz/submit
// Grades the quiz submission, records the attempt, and updates the user's cric points
router.post('/submit', authMiddleware, async (req, res) => {
  const { quizId, answers } = req.body || {};

  if (!quizId || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Fields "quizId" and "answers" (array) are required.' });
  }

  try {
    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found.' });
    }

    if (quiz.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You are not authorized to submit answers for this quiz.' });
    }

    let correctAnswersCount = 0;
    let incorrectAnswersCount = 0;
    const evaluatedAnswers = [];

    // Score the attempt
    for (const question of quiz.questions) {
      const userAns = answers.find(ans => ans.questionId && ans.questionId.toString() === question._id.toString());
      const selectedIndex = userAns ? Number(userAns.selectedOptionIndex) : null;
      
      const hasAnswered = selectedIndex !== null && !isNaN(selectedIndex) && selectedIndex >= 0 && selectedIndex <= 3;
      const isCorrect = hasAnswered && selectedIndex === question.correctOptionIndex;

      if (isCorrect) {
        correctAnswersCount++;
      } else {
        incorrectAnswersCount++;
      }

      evaluatedAnswers.push({
        questionId: question._id,
        questionText: question.questionText,
        options: question.options,
        selectedOptionIndex: hasAnswered ? selectedIndex : null,
        correctOptionIndex: question.correctOptionIndex,
        isCorrect,
        explanation: question.explanation
      });
    }

    // Points calculation: +5 for correct, -1 for wrong
    const pointsEarned = (correctAnswersCount * 5) - (incorrectAnswersCount * 1);

    // Save the attempt record
    const attempt = await QuizAttempt.create({
      userId: req.user._id,
      quizId: quiz._id,
      answers: evaluatedAnswers.map(ans => ({
        questionId: ans.questionId,
        selectedOptionIndex: ans.selectedOptionIndex !== null ? ans.selectedOptionIndex : 0, // Fallback index if omitted
        isCorrect: ans.isCorrect
      })),
      score: correctAnswersCount,
      pointsEarned,
      completedAt: new Date()
    });

    // Update cumulative Cric Points on the user document (ensure it does not fall below 0)
    req.user.cricPoints = Math.max(0, req.user.cricPoints + pointsEarned);
    await req.user.save();

    return res.status(200).json({
      attemptId: attempt._id,
      score: correctAnswersCount,
      totalQuestions: quiz.questions.length,
      pointsEarned,
      cumulativePoints: req.user.cricPoints,
      results: evaluatedAnswers
    });

  } catch (error) {
    console.error('Error submitting quiz answers:', error);
    return res.status(500).json({ error: `Failed to grade and submit quiz: ${error.message}` });
  }
});

// GET /quiz/attempt/:attemptId
// Retrieves the detailed grading results for a past quiz attempt, joining with the Quiz document
router.get('/attempt/:attemptId', authMiddleware, async (req, res) => {
  try {
    const attempt = await QuizAttempt.findById(req.params.attemptId);
    if (!attempt) {
      return res.status(404).json({ error: 'Quiz attempt not found.' });
    }

    if (attempt.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You are not authorized to view this quiz attempt.' });
    }

    const quiz = await Quiz.findById(attempt.quizId);
    if (!quiz) {
      return res.status(404).json({ error: 'Associated quiz content not found.' });
    }

    // Join attempt selections with original quiz questions
    const results = quiz.questions.map(question => {
      const userAns = attempt.answers.find(ans => ans.questionId && ans.questionId.toString() === question._id.toString());
      const selectedIndex = userAns ? userAns.selectedOptionIndex : null;
      const isCorrect = userAns ? userAns.isCorrect : false;

      return {
        questionId: question._id,
        questionText: question.questionText,
        options: question.options,
        selectedOptionIndex: selectedIndex,
        correctOptionIndex: question.correctOptionIndex,
        isCorrect,
        explanation: question.explanation
      };
    });

    return res.status(200).json({
      attemptId: attempt._id,
      score: attempt.score,
      totalQuestions: quiz.questions.length,
      pointsEarned: attempt.pointsEarned,
      completedAt: attempt.completedAt,
      results
    });

  } catch (error) {
    console.error('Error fetching quiz attempt details:', error);
    return res.status(500).json({ error: `Failed to fetch attempt details: ${error.message}` });
  }
});

export default router;
