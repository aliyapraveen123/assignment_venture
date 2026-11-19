FROM python:3.12-slim AS dependencies

WORKDIR /build
COPY requirements.txt ./
RUN python -m pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN groupadd --gid 10001 worker \
    && useradd --uid 10001 --gid worker --create-home --shell /usr/sbin/nologin worker

WORKDIR /app
COPY --from=dependencies /wheels /wheels
COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels
COPY --chown=10001:10001 worker.py ./worker.py

USER 10001:10001
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 \
  CMD python -c "import os, redis; from pymongo import MongoClient; redis.Redis.from_url(os.environ['REDIS_URL'], socket_connect_timeout=2).ping(); MongoClient(os.environ['MONGODB_URI'], serverSelectionTimeoutMS=2000).admin.command('ping')"
CMD ["python", "worker.py"]