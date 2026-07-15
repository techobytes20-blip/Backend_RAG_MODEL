import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from './server/db.js';

dotenv.config({ path: './server/.env' });

const checkDb = async () => {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    const users = await db.collection('users').find({}).toArray();
    console.log("Users in DB:", users.map(u => ({ id: u._id, phone: u.phoneNumber, name: u.name, cricPoints: u.cricPoints, cricCoins: u.cricCoins })));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};
checkDb();
