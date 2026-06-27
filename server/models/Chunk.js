import mongoose from 'mongoose';

const ChunkSchema = new mongoose.Schema({
  filename: {
    type: String,
    required: true,
    index: true
  },
  chunkId: {
    type: Number,
    required: true
  },
  text: {
    type: String,
    required: true
  },
  embedding: {
    type: [Number],
    required: true
  },
  pageNumber: {
    type: Number,
    required: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index to optimize window/parent retrieval query
ChunkSchema.index({ filename: 1, chunkId: 1 });

// Create Mongoose Model
const Chunk = mongoose.model('Chunk', ChunkSchema);

export default Chunk;
