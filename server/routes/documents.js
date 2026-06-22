import express from 'express';
import Chunk from '../models/Chunk.js';

const router = express.Router();

// GET /documents endpoint
router.get('/', async (req, res) => {
  try {
    // Aggregate by unique filename and count the number of chunks for each
    const documents = await Chunk.aggregate([
      {
        $group: {
          _id: '$filename',
          chunkCount: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          filename: '$_id',
          chunkCount: 1
        }
      },
      {
        // Sort alphabetically by filename
        $sort: { filename: 1 }
      }
    ]);

    return res.status(200).json(documents);
  } catch (error) {
    console.error('Error in documents route:', error);
    return res.status(500).json({ error: `Failed to fetch uploaded documents list: ${error.message}` });
  }
});

export default router;
