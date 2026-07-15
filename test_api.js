import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import User from './server/models/User.js';
import connectDB from './server/db.js';

dotenv.config({ path: './server/.env' });

const testApi = async () => {
  await connectDB();
  const user = await User.findOne({ phoneNumber: '+917985829125' });
  
  const token = jwt.sign(
    { userId: user._id },
    process.env.JWT_SECRET || 'fallback_secret',
    { expiresIn: '7d' }
  );
  
  const response = await fetch('http://localhost:5000/auth/profile', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  const data = await response.json();
  console.log("Profile API Response:", JSON.stringify(data, null, 2));
  process.exit(0);
};

testApi();
