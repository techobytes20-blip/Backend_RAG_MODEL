import mammoth from 'mammoth';

/**
 * Extracts raw text from a DOCX file buffer.
 * @param {Buffer} buffer - The DOCX file buffer.
 * @returns {Promise<string>} The extracted text.
 */
export const extractText = async (buffer) => {
  if (!buffer || buffer.length === 0) {
    throw new Error('DOCX buffer is empty or undefined.');
  }

  try {
    const result = await mammoth.extractRawText({ buffer });
    // result.value contains the raw text, result.messages contains any warnings
    return result.value;
  } catch (error) {
    console.error('Error parsing DOCX:', error);
    throw new Error(`Failed to parse DOCX document: ${error.message}`);
  }
};
