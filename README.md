# AI Task Platform

Application repository for the AI Task Processing Platform assignment.

## Services

- `frontend/`: React, Vite, and Tailwind CSS
- `backend/`: Node.js and Express API
- `worker/`: Python worker consuming Redis Streams and updating MongoDB task status

The Kubernetes and Argo CD repository is maintained separately in `../ai-task-platform-infra`.

## Local development

Requirements: Node.js 22+, npm, Python 3.12+, MongoDB, and Redis.

```bash
cd frontend && npm install && npm run dev
```

In another Ubuntu terminal, configure and start the API. The command generates a random local JWT secret directly into `.env`; keep that file private and do not commit it.

```bash
cd backend
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
npm install
npm run dev
```

MongoDB must be running at the URI in `.env`. The API health check is available at `http://localhost:4000/health`.

Redis must be running at `REDIS_URL` for task submission. The local development value is `redis://127.0.0.1:6379`.

In a third Ubuntu terminal, install and start the Python worker. It reads the same `backend/.env` values for MongoDB, Redis, and `TASK_STREAM_KEY`:

```bash
cd worker
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
set -a
source ../backend/.env
set +a
.venv/bin/python worker.py
```

## Authentication (Phase 2)

- `POST /api/auth/register` creates an account and starts a session.
- `POST /api/auth/login` verifies credentials and starts a session.
- `GET /api/auth/me` returns the authenticated user.
- `POST /api/auth/logout` clears the session cookie.

Passwords are stored as bcrypt hashes. JWTs are sent in an `HttpOnly`, `SameSite=Strict` cookie, not browser storage. Registration requires a valid email and a password of at least 12 characters.

Run the auth integration tests with `npm test` from the `backend/` directory. They use a separate local MongoDB database named `ai_task_platform_auth_tests`.

## Task API (Phase 3)

All task routes require the authenticated session cookie.

- `POST /api/tasks` creates a task. JSON body: `{ "title": "Example", "input": "some text", "operation": "uppercase" }`.
- `GET /api/tasks?page=1&limit=20` returns the signed-in user's newest tasks and pagination totals. The maximum page size is 100.
- `GET /api/tasks/:taskId` returns one task owned by the signed-in user.

Allowed operations are `uppercase`, `lowercase`, `reverse`, and `word_count`. New tasks are stored as `pending` and published to the Redis Stream configured by `TASK_STREAM_KEY` (default `ai-task-platform:tasks`). Each stream entry contains string fields `taskId`, `operation`, and `input`; this is the standard Redis Streams format and is compatible with Python `redis` `XREADGROUP`. The worker uses a consumer group, updates MongoDB through `running` to `success` or `failed`, stores the result and processing logs, and acknowledges only after the database update. It reclaims messages idle for five minutes by default. Hinglish: har task sirf usi user ko dikhega jisne use banaya hai.

If Redis is unavailable, the API marks the saved task `failed`, appends a processing log, and returns HTTP 503 so the client can submit it again after Redis recovers.

Task input is limited to 50000 characters and titles to 120 characters. Task API integration tests use a separate local MongoDB database named `ai_task_platform_task_tests` and run with `npm test` from `backend/`.

Run worker unit and Redis/Mongo integration tests with `.venv/bin/python -m unittest -v test_worker.py` from `worker/`, while MongoDB and Redis are running. `word_count` counts whitespace-separated words; an empty or whitespace-only input produces `0`.

## Docker Compose (Phase 6)

From the repository root, create a local Compose secret and start the full stack:

```bash
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
docker compose up --build -d
```

Open `http://localhost:8080`. Nginx serves the frontend and proxies `/api` to the backend. MongoDB and Redis use persistent Compose volumes and remain internal to the Compose network. Backend and worker images run as non-root users.

```bash
docker compose logs -f api worker
docker compose up -d --scale worker=3
docker compose down
```

The generated root `.env` is local-only and ignored by Git. Never reuse its development secret in staging or production.

## Kubernetes and Argo CD (Phase 7)

Manifests are maintained in the sibling `../ai-task-platform-infra` repository. Follow its README to configure Docker Hub image names, Git repository URL, DNS, cluster secrets, and Argo CD Applications. The app images can be built and published after setting your Docker Hub namespace:

```bash
docker build -t YOUR_DOCKERHUB_USER/ai-task-platform-api:staging ./backend
docker build -t YOUR_DOCKERHUB_USER/ai-task-platform-worker:staging ./worker
docker build -t YOUR_DOCKERHUB_USER/ai-task-platform-frontend:staging ./frontend
docker push YOUR_DOCKERHUB_USER/ai-task-platform-api:staging
docker push YOUR_DOCKERHUB_USER/ai-task-platform-worker:staging
docker push YOUR_DOCKERHUB_USER/ai-task-platform-frontend:staging
```

Hinglish: cluster secret Git mein commit mat karein; har environment mein secret alag create karein.

## CI/CD (Phase 8)

The GitHub Actions workflows run backend integration tests against MongoDB/Redis, frontend lint/build, worker integration tests, and all three Docker builds. Pushes to `main` publish immutable `sha-<commit>` images to Docker Hub and update the staging overlay in the infra repository. Production promotion is a manual workflow and only accepts the image tag currently deployed to staging.

Configure these Actions secrets in the application repository:

- `DOCKERHUB_USERNAME`: Docker Hub namespace used for image names.
- `DOCKERHUB_TOKEN`: Docker Hub access token with push permission.
- `INFRA_REPOSITORY`: infrastructure repository in `owner/repo` format.
- `INFRA_REPO_TOKEN`: GitHub token with contents write permission on the infra repository.

Create a GitHub Actions environment named `production` and enable required reviewers before using manual production promotion. The CI test JWT is disposable and is not used by any deployment.