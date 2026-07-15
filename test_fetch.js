import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import connectDB from './server/db.js';
import User from './server/models/User.js';

dotenv.config({ path: './server/.env' });

const testFetch = async () => {
  await connectDB();
  const user = await User.findOne({ phoneNumber: '+917985829125' });
  console.log("User object from mongoose:", user.toObject());
  process.exit(0);
};

testFetch();
