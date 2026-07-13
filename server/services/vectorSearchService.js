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
          pageNumber: 1,
          score: { $meta: 'vectorSearchScore' } // Project similarity score
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

/**
 * Keyword-Coverage Hybrid Reranking.
 * Combines MongoDB Atlas vector search scores with Javascript-based keyword coverage and density metrics.
 * 
 * @param {string} question - The user's query.
 * @param {Array<Object>} chunks - Candidates returned from vector search.
 * @param {number} limit - Number of top chunks to select.
 * @returns {Array<Object>} Reranked top chunks.
 */
export const rerankChunks = (question, chunks, limit = 5) => {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  if (chunks.length <= limit) return chunks;

  const stopWords = new Set([
    'what', 'is', 'the', 'difference', 'between', 'and', 'compare', 'vs', 'versus', 
    'how', 'why', 'are', 'in', 'of', 'a', 'to', 'for', 'with', 'on', 'about', 'can', 
    'you', 'tell', 'me', 'who', 'when', 'where', 'which', 'do', 'does', 'did', 'cricket',
    'player', 'players', 'match', 'team', 'run', 'wicket', 'ball', 'over', 'game', 'play',
    'from', 'terms', 'famous', 'example', 'examples', 'detail', 'details', 'explanation',
    'definition', 'tip', 'tips', 'fact', 'facts', 'pro', 'matters', 'used', 'using'
  ]);
  
  const rawKeywords = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  const keywords = [...new Set(rawKeywords)];

  if (keywords.length === 0) {
    // If no unique keywords, return vector-sorted chunks
    return chunks.slice(0, limit);
  }

  const scoredChunks = chunks.map(chunk => {
    const textLower = (chunk.text || '').toLowerCase();
    let matchCount = 0;
    let frequencyCount = 0;

    keywords.forEach(keyword => {
      if (textLower.includes(keyword)) {
        matchCount++;
        // Count frequency of occurrences
        const regex = new RegExp(keyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
        const matches = textLower.match(regex);
        if (matches) {
          frequencyCount += matches.length;
        }
      }
    });

    const keywordCoverage = matchCount / keywords.length; // 0 to 1
    const keywordDensity = Math.min(frequencyCount / 10, 1); // Cap at 1.0 (10 matches)
    const vectorScore = chunk.score || 0;

    // Weight formula: 60% vector score, 30% keyword coverage, 10% keyword density
    const combinedScore = (vectorScore * 0.6) + (keywordCoverage * 0.3) + (keywordDensity * 0.1);

    return {
      chunk,
      combinedScore
    };
  });

  // Sort descending by combined score
  scoredChunks.sort((a, b) => b.combinedScore - a.combinedScore);

  return scoredChunks.slice(0, limit).map(item => item.chunk);
};

/**
 * Contextual Window Retrieval (Parent-Child).
 * Groups matched candidate chunks by document, merges contiguous indexes,
 * fetches their adjacent helper chunks from MongoDB, and merges them to build contiguous context blocks.
 * 
 * @param {Array<Object>} chunks - Top matched and reranked chunks.
 * @returns {Promise<Array<Object>>} Chunks with expanded text.
 */
export const expandChunksContext = async (chunks) => {
  if (!chunks || chunks.length === 0) return [];

  // Group chunks by filename
  const chunksByFile = {};
  chunks.forEach(chunk => {
    if (!chunksByFile[chunk.filename]) {
      chunksByFile[chunk.filename] = [];
    }
    chunksByFile[chunk.filename].push(chunk);
  });

  const allMergedChunks = [];

  for (const filename of Object.keys(chunksByFile)) {
    const fileChunks = chunksByFile[filename];
    
    // Sort retrieved chunks by chunkId
    fileChunks.sort((a, b) => a.chunkId - b.chunkId);

    // Group contiguous chunkIds. Example: [2, 3, 5] -> [[2, 3], [5]]
    const segments = [];
    let currentSegment = [fileChunks[0]];

    for (let i = 1; i < fileChunks.length; i++) {
      const prev = fileChunks[i - 1];
      const curr = fileChunks[i];
      
      if (curr.chunkId === prev.chunkId + 1) {
        currentSegment.push(curr);
      } else {
        segments.push(currentSegment);
        currentSegment = [curr];
      }
    }
    segments.push(currentSegment);

    // Expand each segment and retrieve from database
    for (const segment of segments) {
      const minId = segment[0].chunkId;
      const maxId = segment[segment.length - 1].chunkId;
      
      let dbChunks;

      // For PDFs, expand context to include the entire current page(s) plus the next page
      if (filename.toLowerCase().endsWith('.pdf')) {
        const segmentPageNumbers = segment
          .map(c => c.pageNumber)
          .filter(p => p !== null && p !== undefined);

        if (segmentPageNumbers.length > 0) {
          const minPage = Math.max(1, Math.min(...segmentPageNumbers) - 1);
          const maxPage = Math.max(...segmentPageNumbers);
          
          console.log(`[Context Expansion] Fetching chunks for PDF pages ${minPage} to ${maxPage + 1}`);
          dbChunks = await Chunk.find({
            filename,
            pageNumber: { $gte: minPage, $lte: maxPage + 1 }
          }).sort({ chunkId: 1 });
        }
      }

      // Fallback for non-PDFs or if page numbers are not available
      if (!dbChunks || dbChunks.length === 0) {
        const startId = Math.max(0, minId - 2);
        const endId = maxId + 3;
        dbChunks = await Chunk.find({
          filename,
          chunkId: { $gte: startId, $lte: endId }
        }).sort({ chunkId: 1 });
      }

      if (dbChunks && dbChunks.length > 0) {
        // Merge the texts
        const mergedText = dbChunks.map(c => c.text).join('\n\n');
        
        // Find the matching source page numbers
        const pageNumbers = [...new Set(dbChunks.map(c => c.pageNumber).filter(p => p !== null && p !== undefined))];
        
        // Create an expanded chunk object
        const baseChunk = segment[0];
        
        allMergedChunks.push({
          _id: baseChunk._id,
          filename: baseChunk.filename,
          chunkId: baseChunk.chunkId,
          text: mergedText,
          pageNumber: pageNumbers.length > 0 ? pageNumbers[0] : baseChunk.pageNumber,
          pageNumbers,
          score: baseChunk.score,
          expanded: true
        });
      }
    }
  }

  // Sort final merged chunks by score descending to present the most relevant context blocks first
  allMergedChunks.sort((a, b) => (b.score || 0) - (a.score || 0));
  return allMergedChunks;
};
