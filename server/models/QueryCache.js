import mongoose from 'mongoose';

const QueryCacheSchema = new mongoose.Schema({
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
  answer: {
    type: String,
    required: true
  },
  sources: [
    {
      filename: { type: String, required: true },
      chunkId: { type: Number, required: true }
    }
  ],
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 604800 // 7 days in seconds (7 * 24 * 60 * 60)
  }
});

const QueryCache = mongoose.model('QueryCache', QueryCacheSchema);

export default QueryCache;
