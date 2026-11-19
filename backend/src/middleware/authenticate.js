import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export default async function authenticate(request, response, next) {
  const token = request.cookies?.accessToken;

  if (!token) {
    return response.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'ai-task-platform',
      audience: 'ai-task-platform-api',
    });
    const user = await User.findById(payload.sub).select('_id email');

    if (!user) {
      return response.status(401).json({ error: 'Authentication required.' });
    }

    request.user = user;
    return next();
  } catch {
    return response.status(401).json({ error: 'Authentication required.' });
  }
}