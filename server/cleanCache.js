import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import QueryCache from './models/QueryCache.js';
import connectDB from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const cleanCache = async () => {
  try {
    await connectDB();
    console.log('Connected to MongoDB. Finding cached queries...');
    
    // Find all cached queries
    const caches = await QueryCache.find({});
    console.log(`Found ${caches.length} cached items.`);
    
    let updatedCount = 0;

    for (const cache of caches) {
      // Apply the same regex to the cached answer
      const originalAnswer = cache.answer;
      const updatedAnswer = originalAnswer.replace(/\n*\s*Detailed Explanation:.*?(?=\n[A-Za-z ]+:|$)/gs, '');
      
      if (originalAnswer !== updatedAnswer) {
        cache.answer = updatedAnswer;
        await cache.save();
        updatedCount++;
      }
    }

    console.log(`Successfully updated ${updatedCount} cached answers to remove 'Detailed Explanation'.`);
    process.exit(0);
  } catch (error) {
    console.error('Error cleaning cache:', error);
    process.exit(1);
  }
};

cleanCache();
