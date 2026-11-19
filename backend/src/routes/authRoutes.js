import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api',
  maxAge: 60 * 60 * 1000,
};

function validEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function validPassword(password) {
  return typeof password === 'string'
    && password.length >= 12
    && Buffer.byteLength(password, 'utf8') <= 72;
}

function issueSession(response, user, status = 200) {
  const token = jwt.sign({}, process.env.JWT_SECRET, {
    subject: user.id,
    expiresIn: '1h',
    issuer: 'ai-task-platform',
    audience: 'ai-task-platform-api',
    algorithm: 'HS256',
  });

  response.cookie('accessToken', token, cookieOptions);
  return response.status(status).json({
    user: { id: user.id, email: user.email },
  });
}

router.post('/register', authLimiter, async (request, response) => {
  const { email, password } = request.body ?? {};

  if (!validEmail(email) || !validPassword(password)) {
    return response.status(400).json({
      error: 'Enter a valid email and a password of at least 12 characters (maximum 72 UTF-8 bytes).',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const user = await User.create({ email: normalizedEmail, passwordHash });
    return issueSession(response, user, 201);
  } catch (error) {
    if (error?.code === 11000) {
      return response.status(409).json({ error: 'An account with this email already exists.' });
    }
    throw error;
  }
});

router.post('/login', authLimiter, async (request, response) => {
  const { email, password } = request.body ?? {};

  if (!validEmail(email) || typeof password !== 'string' || password.length === 0) {
    return response.status(400).json({ error: 'Enter a valid email and password.' });
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash');
  const passwordMatches = user && await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatches) {
    return response.status(401).json({ error: 'Email or password is incorrect.' });
  }

  return issueSession(response, user);
});

router.get('/me', authenticate, (request, response) => {
  response.status(200).json({
    user: { id: request.user.id, email: request.user.email },
  });
});

router.post('/logout', (_request, response) => {
  response.clearCookie('accessToken', cookieOptions);
  response.status(204).end();
});

export default router;