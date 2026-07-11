import mongoose from 'mongoose';

const UserHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  sessionId: {
    type: String,
    required: false,
    index: true
  },
  question: {
    type: String,
    required: true
  },
  answer: {
    type: String,
    required: true
  },
  chunks: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chunk'
    }
  ],
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const UserHistory = mongoose.model('UserHistory', UserHistorySchema);

export default UserHistory;
