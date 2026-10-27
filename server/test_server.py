import copy
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path
from server import ApiError, EventStore, make_handler
from migrate import prepare, summary

SEED = {"id": "seed", "clock": 0, "kind": "seed", "rows": [{"date": "2026-01-05", "filePath": "笔记.md", "wordCountStart": 100, "charCountStart": 300, "changes": [{"timeKey": "12:00", "w": -5, "c": -10}]}]}

def event(identifier):
    return {"id": identifier, "clock": 1, "kind": "delta", "value": {"date": "2026-10-27", "filePath": "test.md", "wordCountStart": 0, "charCountStart": 0, "timeKey": "10:00", "w": 10, "c": 30}}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "test.sqlite3"
        self.store = EventStore(self.path)
        self.bootstrap()

    def tearDown(self):
        self.temp.cleanup()

    def bootstrap(self, seed=SEED):
        return self.store.handle("/v1/bootstrap", {"vaultId": "writing", "seed": seed})

    def sync(self, events=None, cursor=0):
        return self.store.handle("/v1/sync", {"vaultId": "writing", "cursor": cursor, "events": events or []})

    def test_seed_retry_and_different_import_refused(self):
        self.bootstrap()
        self.assertEqual(len(self.sync()["events"]), 1)
        changed = copy.deepcopy(SEED)
        changed["rows"][0]["changes"][0]["w"] = 100
        with self.assertRaises(ApiError) as error:
            self.bootstrap(changed)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.sync()["events"][0]["event"], SEED)

    def test_retry_and_restart(self):
        self.sync([event("a")])
        self.store = EventStore(self.path)
        self.sync([event("a")])
        self.assertEqual(len(self.sync()["events"]), 2)

    def test_conflicting_id_rolls_back_whole_batch(self):
        self.sync([event("a")])
        changed = event("a")
        changed["value"]["w"] = 999
        with self.assertRaises(ApiError):
            self.sync([event("b"), changed])
        self.assertEqual([row["event"]["id"] for row in self.sync()["events"]], ["seed", "a"])

    def test_parallel_devices(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i: self.sync([event(f"device-{i}")]), range(40)))
        self.assertEqual(len(self.sync()["events"]), 41)

    def test_pagination_and_old_server_detection(self):
        for batch in range(6):
            self.sync([event(f"{batch}-{i}") for i in range(100)])
        first = self.sync()
        self.assertTrue(first["hasMore"])
        second = self.sync(cursor=first["cursor"])
        self.assertEqual(len(first["events"]) + len(second["events"]), 601)
        self.assertFalse(second["hasMore"])
        with self.assertRaises(ApiError):
            self.sync(cursor=99999)

    def test_invalid_inputs_leave_database_unchanged(self):
        for mutate in (lambda e: e["value"].update(w=1.5), lambda e: e["value"].update(date="2026-02-30"), lambda e: e.update(kind="seed")):
            candidate = event("bad")
            mutate(candidate)
            with self.assertRaises(ApiError):
                self.sync([candidate])
        self.assertEqual(len(self.sync()["events"]), 1)

    def test_auth_and_http_protocol(self):
        token = "x" * 64
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.store, token))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/v1/sync"
            body = json.dumps({"vaultId": "writing", "cursor": 0, "events": []}).encode()
            request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 401)
            request.add_header("Authorization", "Bearer " + token)
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)["events"][0]["event"], SEED)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_legacy_migration_preserves_all_values(self):
        path = Path(self.temp.name) / "data.json"
        rows = copy.deepcopy(SEED["rows"])
        rows[0]["id"] = 42
        path.write_text(json.dumps({"schema": "0.2", "stats": {"dailyActivity": rows}}))
        seed = prepare(path)
        self.assertEqual(seed, SEED)
        self.assertEqual(summary(seed)["words_delta"], -5)
        self.assertEqual(summary(seed)["start_characters"], 300)


if __name__ == "__main__":
    unittest.main()
