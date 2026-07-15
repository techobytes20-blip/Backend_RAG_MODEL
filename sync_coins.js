import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from './server/db.js';
import User from './server/models/User.js';
import QuizAttempt from './server/models/QuizAttempt.js';

dotenv.config({ path: './server/.env' });

const syncCoins = async () => {
  try {
    await connectDB();
    
    const users = await User.find({});
    console.log(`Found ${users.length} users. Syncing coins...`);
    
    for (const user of users) {
      // Find all attempts for this user
      const attempts = await QuizAttempt.find({ userId: user._id });
      
      let calculatedCoins = 0;
      for (const attempt of attempts) {
        calculatedCoins += (attempt.pointsEarned || 0);
      }
      
      calculatedCoins = Math.max(0, calculatedCoins); // Can't be negative
      
      console.log(`User ${user.phoneNumber}: Old Coins=${user.cricCoins}, New Coins=${calculatedCoins}`);
      
      user.cricCoins = calculatedCoins;
      // also remove cricPoints if it exists
      user.cricPoints = undefined; 
      
      await user.save();
    }
    
    console.log("Sync complete!");
    process.exit(0);
  } catch (error) {
    console.error("Sync failed:", error);
    process.exit(1);
  }
};

syncCoins();
