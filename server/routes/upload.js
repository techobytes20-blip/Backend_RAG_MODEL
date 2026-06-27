import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as pdfService from '../services/pdfService.js';
import * as docxService from '../services/docxService.js';
import * as chunkService from '../services/chunkService.js';
import * as embeddingService from '../services/embeddingService.js';
import Chunk from '../models/Chunk.js';
import { cacheManager } from '../utils/cacheManager.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique name to prevent collisions
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

// File filter to restrict to PDF, DOCX, and TXT
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf' || ext === '.docx' || ext === '.txt') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOCX, and TXT files are accepted.'));
    }
  }
});

// POST /upload endpoint
router.post('/', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  const filePath = req.file.path;
  const originalName = req.file.originalname;

  try {
    let text = '';
    const ext = path.extname(originalName).toLowerCase();
    const buffer = fs.readFileSync(filePath);

    // 1. Text extraction based on file extension (normalizing into page array)
    let pages = [];
    if (ext === '.pdf') {
      pages = await pdfService.extractTextWithPages(buffer);
    } else if (ext === '.docx') {
      text = await docxService.extractText(buffer);
      pages = [{ pageNumber: 1, text }];
    } else if (ext === '.txt') {
      text = buffer.toString('utf-8');
      pages = [{ pageNumber: 1, text }];
    }

    // 2. Validate extracted text
    const hasText = pages.some(p => p.text && p.text.trim().length > 0);
    if (!hasText) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'The uploaded file is empty or contains no extractable text.' });
    }

    // 3. Chunk text page-by-page into 500-1000 character windows with 200 character overlap
    const chunks = [];
    for (const page of pages) {
      if (!page.text || page.text.trim().length === 0) continue;
      const pageChunks = chunkService.createChunks(page.text, 500, 1000, 200);
      for (const chunkText of pageChunks) {
        chunks.push({
          text: chunkText,
          pageNumber: page.pageNumber
        });
      }
    }

    if (chunks.length === 0) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Failed to split document text into semantic chunks.' });
    }

    // 4. Generate embeddings for all chunks sequentially (rate limit safe)
    const chunkTexts = chunks.map(c => c.text);
    console.log(`Generating embeddings for ${chunks.length} chunks of "${originalName}"...`);
    const embeddings = await embeddingService.generateEmbeddingsBatch(chunkTexts);

    // 5. Build database documents
    const chunkDocuments = chunks.map((chunk, index) => ({
      filename: originalName,
      chunkId: index,
      text: chunk.text,
      embedding: embeddings[index],
      pageNumber: chunk.pageNumber,
      createdAt: new Date()
    }));

    // 6. Save chunks to MongoDB Atlas
    await Chunk.insertMany(chunkDocuments);

    // 7. Cleanup local uploaded file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Invalidate semantic and exact cache since knowledge source has changed
    await cacheManager.clear();

    return res.status(200).json({
      message: 'File uploaded, parsed, embedded, and indexed successfully.',
      filename: originalName,
      chunksCount: chunks.length
    });

  } catch (error) {
    // Ensure temporary file cleanup on failure
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    console.error(`Error in upload route processing for "${originalName}":`, error);
    return res.status(500).json({ error: `Failed to process uploaded file: ${error.message}` });
  }
});

export default router;
