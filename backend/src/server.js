import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';
import { closeTaskQueue } from './services/taskQueue.js';

const port = Number(process.env.PORT) || 4000;
const jwtSecret = process.env.JWT_SECRET;

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI must be configured.');
}

if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
  throw new Error('JWT_SECRET must contain at least 32 bytes.');
}

await mongoose.connect(process.env.MONGODB_URI);

const server = app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});

const shutdown = () => {
  server.close(async () => {
    await Promise.all([mongoose.disconnect(), closeTaskQueue()]);
    process.exit(0);
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);