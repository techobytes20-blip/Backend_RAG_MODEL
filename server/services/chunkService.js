/**
 * Splits text into chunks of 500-1000 characters with a 100-character overlap.
 * Tries to align chunk boundaries with sentences or word boundaries to preserve semantics.
 * 
 * @param {string} text - The input text to chunk.
 * @param {number} minSize - Minimum chunk size (default: 500).
 * @param {number} maxSize - Maximum chunk size (default: 1000).
 * @param {number} overlap - Overlap size between adjacent chunks (default: 100).
 * @returns {string[]} An array of text chunks.
 */
export const createChunks = (text, minSize = 500, maxSize = 1000, overlap = 100) => {
  if (!text || typeof text !== 'string') return [];
  
  // Normalize whitespace to avoid empty chunks or formatting issues
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  
  if (normalizedText.length <= maxSize) {
    return normalizedText.length > 0 ? [normalizedText] : [];
  }
  
  const chunks = [];
  let start = 0;
  const textLength = normalizedText.length;
  
  while (start < textLength) {
    let end = start + maxSize;
    if (end >= textLength) {
      end = textLength;
    } else {
      // Look for a sentence or word boundary within [start + minSize, end]
      const searchWindow = normalizedText.slice(start + minSize, end);
      
      // Try to find the last sentence boundary (., !, ?) followed by a space
      const sentenceBoundaryIndex = Math.max(
        searchWindow.lastIndexOf('. '),
        searchWindow.lastIndexOf('! '),
        searchWindow.lastIndexOf('? ')
      );
      
      if (sentenceBoundaryIndex !== -1) {
        // End boundary is at the end of the sentence (including punctuation)
        end = start + minSize + sentenceBoundaryIndex + 1;
      } else {
        // Fallback to the last word boundary (space)
        const wordBoundaryIndex = searchWindow.lastIndexOf(' ');
        if (wordBoundaryIndex !== -1) {
          end = start + minSize + wordBoundaryIndex;
        }
      }
    }
    
    const chunkText = normalizedText.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push(chunkText);
    }
    
    // Calculate the next start position
    const nextStart = end - overlap;
    
    // Safety check to prevent infinite loops: if we are not moving forward, force progress
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
  }
  
  return chunks;
};
