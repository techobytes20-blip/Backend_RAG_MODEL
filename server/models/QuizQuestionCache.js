import mongoose from 'mongoose';

const QuizQuestionCacheSchema = new mongoose.Schema({
  hash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  question: {
    type: String,
    required: true
  },
  embedding: {
    type: [Number],
    required: true
  },
  mcq: {
    questionText: {
      type: String,
      required: true
    },
    options: {
      type: [String],
      required: true,
      validate: [opts => opts.length === 4, 'Must have exactly 4 options']
    },
    correctOptionIndex: {
      type: Number,
      required: true,
      min: 0,
      max: 3
    },
    explanation: {
      type: String,
      required: true
    }
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 604800 // 7 days in seconds (7 * 24 * 60 * 60)
  }
});

const QuizQuestionCache = mongoose.model('QuizQuestionCache', QuizQuestionCacheSchema);

export default QuizQuestionCache;
