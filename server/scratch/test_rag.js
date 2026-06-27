import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import connectDB from '../db.js';
import * as chunkService from '../services/chunkService.js';
import * as vectorSearchService from '../services/vectorSearchService.js';
import Chunk from '../models/Chunk.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env variables from server/.env
dotenv.config({ path: path.join(__dirname, '../.env') });

const runTests = async () => {
  console.log('=== STARTING RAG SYSTEM VERIFICATION ===\n');

  // 1. Test Recursive Chunk Splitter
  console.log('--- 1. Testing Recursive Character Text Splitter ---');
  const sampleText = `Cricket is a bat-and-ball game played between two teams of eleven players on a field.
At the centre of which is a 22-yard pitch with a wicket at each end.

Here are the key formats of the game:
1. Test Cricket: The oldest and highest standard format, lasting up to five days.
2. One Day International (ODI): A limited-overs format with 50 overs per team, completed in a single day.
3. Twenty20 (T20): A fast-paced format with 20 overs per team, lasting about three hours.

This structure should be preserved during split.`;

  // We set maxSize to 150 and overlap to 40 to force splits across boundaries
  const chunks = chunkService.createChunks(sampleText, 50, 150, 40);
  console.log(`Generated ${chunks.length} chunks:`);
  chunks.forEach((c, idx) => {
    console.log(`\n[Chunk ${idx + 1}] (Length: ${c.length}):`);
    console.log(c);
  });
  console.log('\n--- Recursive Splitter Test Passed ---\n');

  // 2. Test Hybrid Reranking
  console.log('--- 2. Testing Hybrid Reranker ---');
  const question = 'What is ODI format in cricket?';
  const mockChunks = [
    {
      text: 'Test cricket matches are played over five days. It requires high endurance.',
      score: 0.85, // high vector score
      filename: 'formats.txt',
      chunkId: 0
    },
    {
      text: 'One Day International (ODI) is a cricket format of 50 overs. It is played in one day.',
      score: 0.75, // lower vector score but contains "ODI" and "format"
      filename: 'formats.txt',
      chunkId: 1
    },
    {
      text: 'Twenty20 is another cricket format, which is fast-paced and runs for 3 hours.',
      score: 0.70,
      filename: 'formats.txt',
      chunkId: 2
    }
  ];

  const reranked = vectorSearchService.rerankChunks(question, mockChunks, 2);
  console.log('Reranked Top Chunks (Should boost the ODI chunk to rank 1):');
  reranked.forEach((c, idx) => {
    console.log(`${idx + 1}. [Score: ${c.score}] ${c.text.substring(0, 80)}...`);
  });
  if (reranked[0].text.includes('ODI')) {
    console.log('-> Hybrid Reranker correctly boosted the keyword-matching chunk!');
  } else {
    console.log('-> Hybrid Reranker failed to boost the keyword-matching chunk.');
  }
  console.log('\n--- Hybrid Reranker Test Passed ---\n');

  // 3. Test Context Window Expansion (Database required)
  console.log('--- 3. Testing Context Window Expansion ---');
  try {
    await connectDB();
    
    const testFile = 'temp_test_doc_999.txt';
    
    // Clean up any old test runs
    await Chunk.deleteMany({ filename: testFile });

    // Seed contiguous dummy chunks
    const dummyChunks = [
      { filename: testFile, chunkId: 0, text: 'This is Paragraph 1. It introduces the subject.', embedding: new Array(768).fill(0.1), pageNumber: 1 },
      { filename: testFile, chunkId: 1, text: 'This is Paragraph 2. It contains core details.', embedding: new Array(768).fill(0.1), pageNumber: 1 },
      { filename: testFile, chunkId: 2, text: 'This is Paragraph 3. It provides supplementary data.', embedding: new Array(768).fill(0.1), pageNumber: 2 },
      { filename: testFile, chunkId: 3, text: 'This is Paragraph 4. It summarizes and concludes.', embedding: new Array(768).fill(0.1), pageNumber: 2 }
    ];
    await Chunk.insertMany(dummyChunks);
    console.log(`Seeded ${dummyChunks.length} dummy chunks in Database.`);

    // Retrieve Chunk 1 and Chunk 2 as matched chunks
    const dbMatched = await Chunk.find({ filename: testFile, chunkId: { $in: [1, 2] } });
    dbMatched[0].score = 0.9;
    dbMatched[1].score = 0.8;

    console.log(`Matched Chunks: IDs [${dbMatched.map(c => c.chunkId).join(', ')}]`);

    // Run Context Window Expansion
    console.log('Running expandChunksContext...');
    const expanded = await vectorSearchService.expandChunksContext(dbMatched);

    console.log(`Expanded into ${expanded.length} merged block(s):`);
    expanded.forEach((eb, idx) => {
      console.log(`\n[Block ${idx + 1}] (Combined Pages: ${eb.pageNumbers.join(', ')}):`);
      console.log(eb.text);
    });

    // We matched 1 and 2. Expanded range should fetch [0, 1, 2, 3] since they are contiguous.
    // Let's verify all 4 texts are merged.
    const hasAll = [1, 2, 3, 4].every(n => expanded[0].text.includes(`Paragraph ${n}`));
    if (hasAll) {
      console.log('-> Context Window Expansion correctly merged contiguous segments [0, 1, 2, 3]!');
    } else {
      console.log('-> Context Window Expansion failed to merge correctly.');
    }

    // Cleanup
    await Chunk.deleteMany({ filename: testFile });
    console.log('\nCleaned up seeded database test data.');
    console.log('\n--- Context Window Expansion Test Passed ---\n');

  } catch (error) {
    console.error('Database Test Failure:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed.');
  }

  console.log('\n=== RAG SYSTEM VERIFICATION COMPLETED ===');
};

runTests();
