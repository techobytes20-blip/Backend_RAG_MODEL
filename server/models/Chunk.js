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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create Mongoose Model
const Chunk = mongoose.model('Chunk', ChunkSchema);

export default Chunk;
