import { createClient } from 'redis';

const streamKey = process.env.TASK_STREAM_KEY || 'ai-task-platform:tasks';
const client = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 2000,
    reconnectStrategy(retries) {
      if (retries > 2) return new Error('Redis connection retries exceeded.');
      return 250;
    },
  },
});

client.on('error', (error) => {
  console.error(`Redis connection error: ${error.message}`);
});

let connectionAttempt;

async function ensureConnected() {
  if (client.isReady) return;

  if (!client.isOpen) {
    connectionAttempt ??= client.connect().finally(() => {
      connectionAttempt = undefined;
    });
    await connectionAttempt;
  }

  if (!client.isReady) {
    throw new Error('Redis is not ready to accept tasks.');
  }
}

export async function enqueueTask(task) {
  await ensureConnected();
  return client.xAdd(streamKey, '*', {
    taskId: String(task._id),
    operation: task.operation,
    input: task.input,
  });
}

export async function closeTaskQueue() {
  if (client.isOpen) await client.close();
}