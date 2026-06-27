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

/**
 * Extracts page-by-page text from a PDF file buffer.
 * @param {Buffer} buffer - The PDF file buffer.
 * @returns {Promise<Array<{pageNumber: number, text: string}>>} Array of page objects.
 */
export const extractTextWithPages = async (buffer) => {
  if (!buffer || buffer.length === 0) {
    throw new Error('PDF buffer is empty or undefined.');
  }

  try {
    const pages = [];
    const options = {
      pagerender: (pageData) => {
        return pageData.getTextContent().then((textContent) => {
          let lastY, text = '';
          for (const item of textContent.items) {
            if (lastY === item.transform[5] || !lastY) {
              text += item.str;
            } else {
              text += '\n' + item.str;
            }
            lastY = item.transform[5];
          }
          pages.push({
            pageNumber: pageData.pageIndex + 1,
            text: text
          });
          return text;
        });
      }
    };

    await parsePdf(buffer, options);

    // Sort pages in ascending order of page numbers (since async execution might render out of order)
    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    return pages;
  } catch (error) {
    console.error('Error parsing PDF page-by-page:', error);
    // Fallback: extract all raw text as a single page
    const rawText = await extractText(buffer);
    return [{ pageNumber: 1, text: rawText }];
  }
};
