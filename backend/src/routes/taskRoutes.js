import { Router } from 'express';
import mongoose from 'mongoose';
import authenticate from '../middleware/authenticate.js';
import Task, { taskOperations } from '../models/Task.js';
import { enqueueTask } from '../services/taskQueue.js';

const maxPageSize = 100;

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  return parsed > 0 && parsed <= maximum ? parsed : null;
}

export function createTaskRouter(queueTask = enqueueTask) {
  const router = Router();
  router.use(authenticate);

  router.post('/', async (request, response) => {
  const { title, input, operation } = request.body ?? {};

  if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 120) {
    return response.status(400).json({ error: 'Title must contain between 1 and 120 characters.' });
  }

  if (typeof input !== 'string' || input.length > 50000) {
    return response.status(400).json({ error: 'Input must be text no longer than 50000 characters.' });
  }

  if (!taskOperations.includes(operation)) {
    return response.status(400).json({ error: `Operation must be one of: ${taskOperations.join(', ')}.` });
  }

  const task = await Task.create({
    userId: request.user.id,
    title: title.trim(),
    input,
    operation,
    status: 'pending',
    processingLogs: [{ message: 'Task accepted and waiting for processing.' }],
  });

  try {
    await queueTask(task);
  } catch {
    task.status = 'failed';
    task.processingLogs.push({
      message: 'Task could not be submitted to Redis. Check queue availability and submit it again.',
    });
    await task.save();
    return response.status(503).json({
      error: 'Task could not be queued. Check Redis and submit it again.',
      task,
    });
  }

  return response.status(201).json({ task });
  });

  router.get('/', async (request, response) => {
  const page = parsePositiveInteger(request.query.page, 1);
  const limit = parsePositiveInteger(request.query.limit, 20, maxPageSize);

  if (!page || !limit) {
    return response.status(400).json({ error: `Page must be positive and limit must be between 1 and ${maxPageSize}.` });
  }

  const filter = { userId: request.user.id };
  const [tasks, total] = await Promise.all([
    Task.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Task.countDocuments(filter),
  ]);

  return response.status(200).json({
    tasks,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
  });

  router.get('/:taskId', async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.taskId)) {
    return response.status(404).json({ error: 'Task not found.' });
  }

  const task = await Task.findOne({
    _id: request.params.taskId,
    userId: request.user.id,
  });

  if (!task) {
    return response.status(404).json({ error: 'Task not found.' });
  }

  return response.status(200).json({ task });
  });

  return router;
}

export default createTaskRouter();