import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'phase-two-test-secret-with-at-least-32-bytes';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/ai_task_platform_auth_tests';

const [{ default: app }, { default: User }] = await Promise.all([
  import('../src/app.js'),
  import('../src/models/User.js'),
]);

let server;
let baseUrl;
const email = `auth-test-${Date.now()}@example.test`;
const password = 'correct-horse-battery-42';

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await User.deleteMany({ email });
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
});

async function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('registers a user, issues an HttpOnly session cookie, and protects /me', async () => {
  const response = await post('/api/auth/register', { email, password });
  const cookieHeader = response.headers.get('set-cookie');
  const cookie = cookieHeader?.split(';')[0];

  assert.equal(response.status, 201);
  assert.match(cookieHeader ?? '', /HttpOnly/i);
  assert.match(cookieHeader ?? '', /SameSite=Strict/i);
  assert.ok(cookie);

  const user = await User.findOne({ email }).select('+passwordHash');
  assert.ok(user);
  assert.notEqual(user.passwordHash, password);

  const profile = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie },
  });
  assert.equal(profile.status, 200);
  assert.deepEqual(await profile.json(), {
    user: { id: user.id, email },
  });

  const unauthorized = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(unauthorized.status, 401);
});

test('rejects duplicate accounts and invalid registration input', async () => {
  const duplicate = await post('/api/auth/register', { email, password });
  const invalid = await post('/api/auth/register', {
    email: 'not-an-email',
    password: 'short',
  });

  assert.equal(duplicate.status, 409);
  assert.equal(invalid.status, 400);
});

test('logs in with the correct password and rejects an incorrect password', async () => {
  const login = await post('/api/auth/login', { email, password });
  const rejected = await post('/api/auth/login', {
    email,
    password: 'wrong-password-123',
  });

  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.equal(rejected.status, 401);
});

test('clears the session cookie on logout', async () => {
  const response = await post('/api/auth/logout', {});

  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie') ?? '', /Expires=Thu, 01 Jan 1970/i);
});