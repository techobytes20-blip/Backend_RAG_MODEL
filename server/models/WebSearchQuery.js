import mongoose from 'mongoose';

const WebSearchQuerySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  question: {
    type: String,
    required: true
  },
  standaloneQuestion: {
    type: String,
    required: true
  },
  answer: {
    type: String,
    required: true
  },
  sources: [
    {
      title: { type: String, required: false },
      url: { type: String, required: false }
    }
  ],
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

const WebSearchQuery = mongoose.model('WebSearchQuery', WebSearchQuerySchema);

export default WebSearchQuery;
