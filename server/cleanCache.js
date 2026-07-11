import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import QueryCache from './models/QueryCache.js';
import QuizQuestionCache from './models/QuizQuestionCache.js';
import connectDB from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const clearCache = async () => {
  try {
    await connectDB();
    console.log('Connected to MongoDB. Clearing cache...');
    const result = await QueryCache.deleteMany({});
    const mcqResult = await QuizQuestionCache.deleteMany({});
    console.log(`Successfully deleted ${result.deletedCount} query cache items and ${mcqResult.deletedCount} MCQ cache items.`);
    process.exit(0);
  } catch (error) {
    console.error('Error clearing cache:', error);
    process.exit(1);
  }
};

clearCache();
