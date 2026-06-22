import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import swaggerUi from 'swagger-ui-express';
import connectDB from './db.js';
import uploadRouter from './routes/upload.js';
import askRouter from './routes/ask.js';
import documentsRouter from './routes/documents.js';

// Resolve directory paths in ES module environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from server/.env
dotenv.config({ path: path.join(__dirname, '.env') });

// Load Swagger document
const swaggerDocument = JSON.parse(
  fs.readFileSync(new URL('./swagger.json', import.meta.url))
);

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log incoming requests for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Register API Routes
app.use('/upload', uploadRouter);
app.use('/ask', askRouter);
app.use('/documents', documentsRouter);

// Register Swagger UI documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Redirect root to swagger docs
app.get('/', (req, res) => {
  res.redirect('/api-docs');
});

// Base route for status check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Cricket RAG API is healthy.' });
});

// Global 404 Route handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'An unexpected server error occurred.'
  });
});

// Establish database connection and start Express server
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`=========================================`);
      console.log(` Cricket RAG Server running on port ${PORT}`);
      console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`=========================================`);
    });
  } catch (error) {
    console.error('Failed to start Cricket RAG server due to DB connection error:', error.message);
    process.exit(1);
  }
};

startServer();
