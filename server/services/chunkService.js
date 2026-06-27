/**
 * Splits text recursively using logical separators to preserve structural formatting (e.g. paragraphs, lists).
 * Uses backtracking to construct syntactic overlap instead of slicing blindly mid-word.
 * 
 * @param {string} text - The input text to chunk.
 * @param {number} minSize - Minimum chunk size (ignored, kept for signature compatibility).
 * @param {number} maxSize - Maximum chunk size (default: 1000).
 * @param {number} overlap - Overlap size between adjacent chunks (default: 200).
 * @returns {string[]} An array of text chunks.
 */
export const createChunks = (text, minSize = 500, maxSize = 1000, overlap = 200) => {
  if (!text || typeof text !== 'string') return [];
  
  // Normalize Windows newlines and multiple spaces, but preserve newlines
  const cleanedText = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  
  if (cleanedText.length <= maxSize) {
    return cleanedText.length > 0 ? [cleanedText] : [];
  }
  
  const separators = ['\n\n', '\n', ' ', ''];
  
  const splitText = (txt, separatorIdx) => {
    if (txt.length <= maxSize) return [txt];
    
    if (separatorIdx >= separators.length) {
      // Hard fallback if all separators are exhausted
      const chunks = [];
      let start = 0;
      while (start < txt.length) {
        let end = start + maxSize;
        chunks.push(txt.slice(start, end));
        start = end - overlap;
        if (start >= txt.length || end >= txt.length) break;
      }
      return chunks;
    }
    
    const separator = separators[separatorIdx];
    const parts = txt.split(separator);
    const result = [];
    
    for (const part of parts) {
      if (part.length <= maxSize) {
        result.push(part);
      } else {
        result.push(...splitText(part, separatorIdx + 1));
      }
    }
    
    return result;
  };
  
  const rawSplits = splitText(cleanedText, 0);
  
  const chunks = [];
  let currentChunk = '';
  
  for (let i = 0; i < rawSplits.length; i++) {
    const split = rawSplits[i];
    if (!split) continue;
    
    if (!currentChunk) {
      currentChunk = split;
    } else {
      // Determine what separator we should use when joining
      const joinStr = (currentChunk.endsWith('\n') || split.startsWith('\n')) ? '' : ' ';
      
      if (currentChunk.length + joinStr.length + split.length <= maxSize) {
        currentChunk += joinStr + split;
      } else {
        chunks.push(currentChunk.trim());
        
        // Construct overlap by backtracking split pieces
        let overlapText = '';
        let j = i - 1;
        while (j >= 0 && overlapText.length + rawSplits[j].length <= overlap) {
          const sep = (rawSplits[j].endsWith('\n') || overlapText.startsWith('\n')) ? '' : ' ';
          overlapText = rawSplits[j] + sep + overlapText;
          j--;
        }
        
        const nextJoinStr = (overlapText.endsWith('\n') || split.startsWith('\n')) ? '' : ' ';
        currentChunk = (overlapText + nextJoinStr + split).slice(-maxSize);
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks.filter(c => c.length > 0);
};
