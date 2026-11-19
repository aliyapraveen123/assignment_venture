import os
import unittest
import uuid

import redis
from bson import ObjectId
from pymongo import MongoClient

from worker import apply_operation, ensure_consumer_group, process_entries, process_message


class OperationTests(unittest.TestCase):
    def test_text_operations(self):
        self.assertEqual(apply_operation("uppercase", "Hello World"), "HELLO WORLD")
        self.assertEqual(apply_operation("lowercase", "Hello World"), "hello world")
        self.assertEqual(apply_operation("reverse", "Hello World"), "dlroW olleH")
        self.assertEqual(apply_operation("word_count", "  one\ttwo\nthree  "), 3)
        self.assertEqual(apply_operation("word_count", "  \n\t "), 0)


class WorkerIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mongo_uri = os.getenv(
            "MONGODB_URI",
            "mongodb://127.0.0.1:27017/ai_task_platform_worker_tests",
        )
        cls.redis_url = os.getenv("REDIS_URL", "redis://127.0.0.1:6379")
        cls.mongo_client = MongoClient(cls.mongo_uri, serverSelectionTimeoutMS=3000)
        cls.mongo_client.admin.command("ping")
        cls.redis_client = redis.Redis.from_url(cls.redis_url, decode_responses=True)
        cls.redis_client.ping()
        cls.database = cls.mongo_client.get_default_database()
        cls.tasks = cls.database["tasks"]
        cls.stream_name = f"ai-task-platform:worker-tests:{uuid.uuid4()}"
        cls.group_name = "worker-test-group"
        cls.consumer_name = "worker-test-consumer"
        ensure_consumer_group(cls.redis_client, cls.stream_name, cls.group_name)

    @classmethod
    def tearDownClass(cls):
        cls.redis_client.delete(cls.stream_name)
        cls.mongo_client.drop_database(cls.database.name)
        cls.redis_client.close()
        cls.mongo_client.close()

    def test_consumes_stream_tasks_persists_results_and_acknowledges(self):
        cases = [
            ("uppercase", "Hello World", "HELLO WORLD"),
            ("lowercase", "Hello World", "hello world"),
            ("reverse", "Hello World", "dlroW olleH"),
            ("word_count", "one two\nthree", 3),
        ]
        created_tasks = []

        for operation, input_text, expected in cases:
            task_id = ObjectId()
            task = {
                "_id": task_id,
                "title": f"Test {operation}",
                "input": input_text,
                "operation": operation,
                "status": "pending",
                "result": None,
                "processingLogs": [],
            }
            self.tasks.insert_one(task)
            created_tasks.append((task_id, input_text, operation, expected))
            self.redis_client.xadd(
                self.stream_name,
                {"taskId": str(task_id), "operation": operation, "input": input_text},
            )

        delivery = self.redis_client.xreadgroup(
            self.group_name,
            self.consumer_name,
            {self.stream_name: ">"},
            count=len(cases),
            block=1000,
        )
        entries = delivery[0][1]
        self.assertEqual(len(entries), len(cases))

        for message_id, fields in entries:
            outcome = process_message(
                self.redis_client,
                self.tasks,
                self.stream_name,
                self.group_name,
                message_id,
                fields,
            )
            self.assertEqual(outcome, "success")

        for task_id, _, _, expected in created_tasks:
            task = self.tasks.find_one({"_id": task_id})
            self.assertEqual(task["status"], "success")
            self.assertEqual(task["result"], expected)
            self.assertEqual(len(task["processingLogs"]), 2)

        pending = self.redis_client.xpending(self.stream_name, self.group_name)
        self.assertEqual(pending["pending"], 0)

    def test_redelivery_of_finished_task_does_not_repeat_processing(self):
        task_id = ObjectId()
        self.tasks.insert_one({
            "_id": task_id,
            "input": "already done",
            "operation": "uppercase",
            "status": "success",
            "result": "ALREADY DONE",
            "processingLogs": [],
        })
        message_id = self.redis_client.xadd(self.stream_name, {
            "taskId": str(task_id),
            "operation": "uppercase",
            "input": "already done",
        })
        delivery = self.redis_client.xreadgroup(
            self.group_name,
            self.consumer_name,
            {self.stream_name: ">"},
            count=1,
            block=1000,
        )
        delivered_id, fields = delivery[0][1][0]

        outcome = process_message(
            self.redis_client,
            self.tasks,
            self.stream_name,
            self.group_name,
            delivered_id,
            fields,
        )

        self.assertEqual(delivered_id, message_id)
        self.assertEqual(outcome, "already-finished")
        self.assertEqual(self.tasks.find_one({"_id": task_id})["processingLogs"], [])

    def test_reclaims_pending_message_from_stopped_consumer(self):
        task_id = ObjectId()
        self.tasks.insert_one({
            "_id": task_id,
            "input": "recover this",
            "operation": "reverse",
            "status": "pending",
            "result": None,
            "processingLogs": [],
        })
        self.redis_client.xadd(self.stream_name, {
            "taskId": str(task_id),
            "operation": "reverse",
            "input": "recover this",
        })
        self.redis_client.xreadgroup(
            self.group_name,
            "stopped-consumer",
            {self.stream_name: ">"},
            count=1,
            block=1000,
        )
        previous_idle = os.environ.get("WORKER_CLAIM_IDLE_MS")
        os.environ["WORKER_CLAIM_IDLE_MS"] = "0"

        try:
            process_entries(
                self.redis_client,
                self.tasks,
                self.stream_name,
                self.group_name,
                "replacement-consumer",
            )
        finally:
            if previous_idle is None:
                os.environ.pop("WORKER_CLAIM_IDLE_MS", None)
            else:
                os.environ["WORKER_CLAIM_IDLE_MS"] = previous_idle

        task = self.tasks.find_one({"_id": task_id})
        self.assertEqual(task["status"], "success")
        self.assertEqual(task["result"], "siht revocer")
        self.assertEqual(self.redis_client.xpending(self.stream_name, self.group_name)["pending"], 0)