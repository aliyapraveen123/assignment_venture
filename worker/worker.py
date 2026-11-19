import logging
import os
import signal
import socket
import threading
import time
from datetime import datetime, timezone

import redis
from bson import ObjectId
from pymongo import MongoClient, ReturnDocument
from pymongo.errors import PyMongoError
from redis.exceptions import RedisError, ResponseError

OPERATIONS = {"uppercase", "lowercase", "reverse", "word_count"}
TERMINAL_STATUSES = {"success", "failed"}
STOP_EVENT = threading.Event()
LOGGER = logging.getLogger("task-worker")


def now_utc():
    return datetime.now(timezone.utc)


def apply_operation(operation, input_text):
    if operation == "uppercase":
        return input_text.upper()
    if operation == "lowercase":
        return input_text.lower()
    if operation == "reverse":
        return input_text[::-1]
    if operation == "word_count":
        return len(input_text.split())
    raise ValueError("Unsupported task operation.")


def acknowledge(redis_client, stream_name, group_name, message_id):
    redis_client.xack(stream_name, group_name, message_id)


def fail_task(tasks, task_id, message):
    timestamp = now_utc()
    tasks.update_one(
        {"_id": task_id, "status": "running"},
        {
            "$set": {"status": "failed", "result": None, "updatedAt": timestamp},
            "$push": {"processingLogs": {"message": message, "timestamp": timestamp}},
        },
    )


def process_message(redis_client, tasks, stream_name, group_name, message_id, fields):
    raw_task_id = fields.get("taskId", "")
    if not ObjectId.is_valid(raw_task_id):
        LOGGER.error("Acknowledging stream entry with invalid task id: %s", message_id)
        acknowledge(redis_client, stream_name, group_name, message_id)
        return "invalid"

    task_id = ObjectId(raw_task_id)
    task = tasks.find_one({"_id": task_id})
    if task is None:
        LOGGER.warning("Acknowledging stream entry for missing task: %s", raw_task_id)
        acknowledge(redis_client, stream_name, group_name, message_id)
        return "missing"

    status = task.get("status")
    if status in TERMINAL_STATUSES:
        acknowledge(redis_client, stream_name, group_name, message_id)
        return "already-finished"

    if status == "pending":
        timestamp = now_utc()
        task = tasks.find_one_and_update(
            {"_id": task_id, "status": "pending"},
            {
                "$set": {"status": "running", "updatedAt": timestamp},
                "$push": {"processingLogs": {"message": "Task processing started.", "timestamp": timestamp}},
            },
            return_document=ReturnDocument.AFTER,
        )
        if task is None:
            task = tasks.find_one({"_id": task_id})
            if task is None or task.get("status") in TERMINAL_STATUSES:
                acknowledge(redis_client, stream_name, group_name, message_id)
                return "already-finished"

    if task.get("status") != "running":
        fail_task(tasks, task_id, "Task has an unsupported status and cannot be processed.")
        acknowledge(redis_client, stream_name, group_name, message_id)
        return "failed"

    if fields.get("operation") != task.get("operation") or fields.get("input") != task.get("input"):
        fail_task(tasks, task_id, "Queued task data did not match the saved task.")
        acknowledge(redis_client, stream_name, group_name, message_id)
        return "failed"

    operation = task.get("operation")
    if operation not in OPERATIONS:
        fail_task(tasks, task_id, "Task requested an unsupported operation.")
        acknowledge(redis_client, stream_name, group_name, message_id)
        return "failed"

    try:
        result = apply_operation(operation, task.get("input", ""))
    except Exception:
        LOGGER.exception("Task processing failed for task %s", raw_task_id)
        fail_task(tasks, task_id, "Task processing failed.")
        acknowledge(redis_client, stream_name, group_name, message_id)
        return "failed"

    timestamp = now_utc()
    tasks.update_one(
        {"_id": task_id, "status": "running"},
        {
            "$set": {"status": "success", "result": result, "updatedAt": timestamp},
            "$push": {"processingLogs": {"message": "Task completed successfully.", "timestamp": timestamp}},
        },
    )
    acknowledge(redis_client, stream_name, group_name, message_id)
    return "success"


def ensure_consumer_group(redis_client, stream_name, group_name):
    try:
        redis_client.xgroup_create(stream_name, group_name, id="0-0", mkstream=True)
    except ResponseError as error:
        if "BUSYGROUP" not in str(error):
            raise


def process_entries(redis_client, tasks, stream_name, group_name, consumer_name):
    reclaimed = redis_client.xautoclaim(
        stream_name,
        group_name,
        consumer_name,
        min_idle_time=int(os.getenv("WORKER_CLAIM_IDLE_MS", "300000")),
        start_id="0-0",
        count=10,
    )
    for message_id, fields in reclaimed[1]:
        process_message(redis_client, tasks, stream_name, group_name, message_id, fields)

    new_messages = redis_client.xreadgroup(
        group_name,
        consumer_name,
        {stream_name: ">"},
        count=10,
        block=5000,
    )
    for _, entries in new_messages:
        for message_id, fields in entries:
            process_message(redis_client, tasks, stream_name, group_name, message_id, fields)


def run_worker(redis_client, tasks, stream_name, group_name, consumer_name):
    ensure_consumer_group(redis_client, stream_name, group_name)
    LOGGER.info("Worker %s consuming stream %s", consumer_name, stream_name)

    while not STOP_EVENT.is_set():
        try:
            process_entries(redis_client, tasks, stream_name, group_name, consumer_name)
        except (RedisError, PyMongoError):
            LOGGER.exception("Worker could not process the queue; retrying shortly")
            STOP_EVENT.wait(2)


def request_shutdown(_signal_number, _frame):
    STOP_EVENT.set()


def main():
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    mongo_uri = os.getenv("MONGODB_URI")
    if not mongo_uri:
        raise RuntimeError("MONGODB_URI must be configured.")

    stream_name = os.getenv("TASK_STREAM_KEY", "ai-task-platform:tasks")
    group_name = os.getenv("TASK_CONSUMER_GROUP", "ai-task-platform:workers")
    consumer_name = os.getenv("TASK_CONSUMER_NAME", f"{socket.gethostname()}-{os.getpid()}")
    redis_client = redis.Redis.from_url(
        os.getenv("REDIS_URL", "redis://127.0.0.1:6379"),
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=10,
    )
    mongo_client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
    tasks = mongo_client.get_default_database()["tasks"]

    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)

    try:
        redis_client.ping()
        mongo_client.admin.command("ping")
        run_worker(redis_client, tasks, stream_name, group_name, consumer_name)
    finally:
        redis_client.close()
        mongo_client.close()


if __name__ == "__main__":
    main()