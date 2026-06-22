import Chunk from '../models/Chunk.js';

/**
 * Queries the MongoDB Atlas Vector Search index for similar document chunks.
 * 
 * @param {number[]} queryVector - The embedding vector of the search query.
 * @param {number} limit - The number of top documents to return (default: 5).
 * @returns {Promise<Array>} The aggregated search results.
 */
export const searchSimilar = async (queryVector, limit = 5) => {
  if (!queryVector || !Array.isArray(queryVector)) {
    throw new Error('Query vector is required and must be an array.');
  }

  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: 'vector_index', // This must match the index name configured in Atlas
          path: 'embedding',      // Path to the embedding array in the schema
          queryVector: queryVector,
          numCandidates: 100,     // Candidates to inspect (higher is more accurate)
          limit: limit            // Max results to return
        }
      },
      {
        $project: {
          _id: 1,
          filename: 1,
          chunkId: 1,
          text: 1,
          score: { $meta: 'searchScore' } // Project similarity score
        }
      }
    ];

    const results = await Chunk.aggregate(pipeline);
    return results;
  } catch (error) {
    console.error('Error during MongoDB Atlas Vector Search:', error);
    throw new Error(`Vector Search Failure: ${error.message}`);
  }
};
