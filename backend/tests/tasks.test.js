import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createClient } from 'redis';

process.env.JWT_SECRET = 'phase-three-test-secret-with-at-least-32-bytes';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/ai_task_platform_task_tests';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.TASK_STREAM_KEY = `ai-task-platform:test:${Date.now()}`;
const streamKey = process.env.TASK_STREAM_KEY;

const [
  { default: app },
  { default: User },
  { default: Task },
  { createTaskRouter },
  { closeTaskQueue },
] = await Promise.all([
  import('../src/app.js'),
  import('../src/models/User.js'),
  import('../src/models/Task.js'),
  import('../src/routes/taskRoutes.js'),
  import('../src/services/taskQueue.js'),
]);

let server;
let failureServer;
let baseUrl;
let failureUrl;
let queueReader;
let owner;
let otherUser;
let ownerCookie;
let otherCookie;

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  queueReader = createClient({ url: process.env.REDIS_URL });
  await queueReader.connect();
  await queueReader.del(streamKey);
  owner = await User.create({ email: `task-owner-${Date.now()}@example.test`, passwordHash: 'test-hash' });
  otherUser = await User.create({ email: `task-other-${Date.now()}@example.test`, passwordHash: 'test-hash' });
  ownerCookie = makeCookie(owner.id);
  otherCookie = makeCookie(otherUser.id);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const failureApp = express();
  failureApp.use(express.json(), cookieParser());
  failureApp.use('/api/tasks', createTaskRouter(async () => {
    throw new Error('Redis unavailable');
  }));
  failureServer = failureApp.listen(0);
  await new Promise((resolve) => failureServer.once('listening', resolve));
  failureUrl = `http://127.0.0.1:${failureServer.address().port}`;
});

after(async () => {
  await Task.deleteMany({ userId: { $in: [owner._id, otherUser._id] } });
  await User.deleteMany({ _id: { $in: [owner._id, otherUser._id] } });
  await queueReader.del(streamKey);
  await queueReader.close();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => failureServer.close(resolve));
  await closeTaskQueue();
  await mongoose.disconnect();
});

function makeCookie(userId) {
  const token = jwt.sign({}, process.env.JWT_SECRET, {
    subject: userId,
    expiresIn: '1h',
    issuer: 'ai-task-platform',
    audience: 'ai-task-platform-api',
    algorithm: 'HS256',
  });
  return `accessToken=${token}`;
}

async function call(path, { method = 'GET', body, cookie } = {}) {
  return fetch(`${baseUrl}/api/tasks${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('creates a validated pending task and lists task history for its owner', async () => {
  const created = await call('', {
    method: 'POST',
    cookie: ownerCookie,
    body: { title: '  Reverse this  ', input: 'hello world', operation: 'reverse' },
  });
  const createdBody = await created.json();

  assert.equal(created.status, 201);
  assert.equal(createdBody.task.title, 'Reverse this');
  assert.equal(createdBody.task.input, 'hello world');
  assert.equal(createdBody.task.operation, 'reverse');
  assert.equal(createdBody.task.status, 'pending');
  assert.equal(createdBody.task.result, null);
  assert.equal(createdBody.task.userId, undefined);
  assert.equal(createdBody.task.processingLogs.length, 1);

  const streamEntries = await queueReader.xRange(streamKey, '-', '+');
  assert.equal(streamEntries.length, 1);
  assert.deepEqual({ ...streamEntries[0].message }, {
    taskId: createdBody.task._id,
    operation: 'reverse',
    input: 'hello world',
  });

  const list = await call('?page=1&limit=10', { cookie: ownerCookie });
  const listBody = await list.json();
  assert.equal(list.status, 200);
  assert.equal(listBody.pagination.total, 1);
  assert.equal(listBody.pagination.page, 1);
  assert.equal(listBody.tasks[0]._id, createdBody.task._id);
});

test('returns task details only to the owner', async () => {
  const ownerList = await call('', { cookie: ownerCookie });
  const [{ _id: taskId }] = (await ownerList.json()).tasks;

  const ownTask = await call(`/${taskId}`, { cookie: ownerCookie });
  const otherTask = await call(`/${taskId}`, { cookie: otherCookie });
  const malformedId = await call('/not-an-id', { cookie: ownerCookie });
  const otherList = await call('', { cookie: otherCookie });

  assert.equal(ownTask.status, 200);
  assert.equal(otherTask.status, 404);
  assert.equal(malformedId.status, 404);
  assert.equal((await otherList.json()).pagination.total, 0);
});

test('rejects unauthenticated, invalid, and oversized task requests', async () => {
  const unauthorized = await call('', {
    method: 'POST',
    body: { title: 'Test', input: 'text', operation: 'uppercase' },
  });
  const invalidOperation = await call('', {
    method: 'POST',
    cookie: ownerCookie,
    body: { title: 'Test', input: 'text', operation: 'delete' },
  });
  const blankTitle = await call('', {
    method: 'POST',
    cookie: ownerCookie,
    body: { title: '  ', input: '', operation: 'word_count' },
  });
  const oversized = await call('', {
    method: 'POST',
    cookie: ownerCookie,
    body: { title: 'Too long', input: 'x'.repeat(50001), operation: 'uppercase' },
  });
  const invalidPagination = await call('?limit=1000', { cookie: ownerCookie });

  assert.equal(unauthorized.status, 401);
  assert.equal(invalidOperation.status, 400);
  assert.equal(blankTitle.status, 400);
  assert.equal(oversized.status, 400);
  assert.equal(invalidPagination.status, 400);
});

test('marks a task failed and returns 503 when Redis enqueueing fails', async () => {
  const response = await fetch(`${failureUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: ownerCookie,
    },
    body: JSON.stringify({
      title: 'Queue outage test',
      input: 'retry me',
      operation: 'uppercase',
    }),
  });
  const body = await response.json();
  const storedTask = await Task.findById(body.task._id);

  assert.equal(response.status, 503);
  assert.equal(body.task.status, 'failed');
  assert.match(body.task.processingLogs.at(-1).message, /could not be submitted to Redis/);
  assert.equal(storedTask.status, 'failed');
});