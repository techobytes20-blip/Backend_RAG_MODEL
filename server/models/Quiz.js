import mongoose from 'mongoose';

const QuizQuestionSchema = new mongoose.Schema({
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
});

const QuizSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  questions: [QuizQuestionSchema],
  basedOnHistoryIds: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'UserHistory'
    }
  ],
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Quiz = mongoose.model('Quiz', QuizSchema);

export default Quiz;
export { QuizQuestionSchema };
