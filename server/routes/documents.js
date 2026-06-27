import express from 'express';
import Chunk from '../models/Chunk.js';
import { cacheManager } from '../utils/cacheManager.js';

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

// DELETE /documents/:filename endpoint
router.delete('/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!filename) {
    return res.status(400).json({ error: 'Filename parameter is required.' });
  }

  try {
    const result = await Chunk.deleteMany({ filename });
    
    // Invalidate semantic and exact cache since knowledge source has changed
    await cacheManager.clear();

    return res.status(200).json({
      message: `Successfully deleted document "${filename}" and all its ${result.deletedCount} associated chunks from search index.`,
      filename,
      deletedChunksCount: result.deletedCount
    });
  } catch (error) {
    console.error(`Error deleting document "${filename}":`, error);
    return res.status(500).json({ error: `Failed to delete document: ${error.message}` });
  }
});

export default router;
