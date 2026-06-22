import pdfParse from 'pdf-parse';

// Handle potential ESM import compatibility issues with pdf-parse
const parsePdf = pdfParse.default || pdfParse;

/**
 * Extracts raw text from a PDF file buffer.
 * @param {Buffer} buffer - The PDF file buffer.
 * @returns {Promise<string>} The extracted text.
 */
export const extractText = async (buffer) => {
  if (!buffer || buffer.length === 0) {
    throw new Error('PDF buffer is empty or undefined.');
  }

  try {
    const data = await parsePdf(buffer);
    return data.text;
  } catch (error) {
    console.error('Error parsing PDF:', error);
    throw new Error(`Failed to parse PDF document: ${error.message}`);
  }
};
