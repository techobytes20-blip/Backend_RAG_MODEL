import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header is missing or invalid. Use "Bearer <token>".' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    const user = await User.findById(decoded.userId || decoded.id);

    if (!user) {
      return res.status(401).json({ error: 'User associated with this token does not exist.' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware validation error:', error.message);
    return res.status(401).json({ error: 'Invalid or expired authentication token.' });
  }
};
