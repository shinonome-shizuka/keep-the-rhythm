"""KTR event store: Python stdlib + SQLite. Run behind an HTTPS reverse proxy."""
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 16 * 1024 * 1024
MAX_INT = 2**53 - 1


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def require(condition, message):
    if not condition:
        raise ApiError(400, message)


def integer(value, minimum=-MAX_INT):
    return type(value) is int and minimum <= value <= MAX_INT


def text(value, limit=4096):
    return isinstance(value, str) and 0 < len(value) <= limit and "\x00" not in value


def validate_value(value):
    require(isinstance(value, dict), "Invalid delta")
    require(text(value.get("filePath")), "Invalid file path")
    require(isinstance(value.get("date"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value["date"]), "Invalid date")
    from datetime import date
    try:
        date.fromisoformat(value["date"])
    except ValueError:
        raise ApiError(400, "Invalid date")
    for key in ("wordCountStart", "charCountStart"):
        require(integer(value.get(key)), "Invalid start count")


def validate_change(change):
    require(isinstance(change, dict), "Invalid time entry")
    require(isinstance(change.get("timeKey"), str) and re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", change["timeKey"]), "Invalid time")
    require(integer(change.get("w")) and integer(change.get("c")), "Counts must be safe integers")


def validate_event(event, seed=False):
    require(isinstance(event, dict), "Invalid event")
    require(text(event.get("id"), 100) and integer(event.get("clock"), 0), "Invalid event identity")
    kind = event.get("kind")
    if seed:
        require(kind == "seed" and event["id"] == "seed" and event["clock"] == 0, "Invalid seed")
        require(isinstance(event.get("rows"), list) and len(event["rows"]) <= 100000, "Invalid seed rows")
        for row in event["rows"]:
            validate_value(row)
            require(isinstance(row.get("changes"), list) and len(row["changes"]) <= 100000, "Invalid changes")
            for change in row["changes"]:
                validate_change(change)
        return
    require(event["id"] != "seed" and not event["id"].startswith("seed:"), "Reserved event ID")
    require(kind in ("delta", "remove", "rename"), "Unknown event kind")
    if kind == "delta":
        validate_value(event.get("value"))
        validate_change(event["value"])
    else:
        require(isinstance(event.get("targets"), list) and len(event["targets"]) <= 100000, "Invalid targets")
        require(all(text(target, 100) for target in event["targets"]), "Invalid target ID")
        if kind == "rename":
            require(text(event.get("path")), "Invalid new path")


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class EventStore:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, seed_hash TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    vault TEXT NOT NULL,
                    id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    UNIQUE(vault, id)
                );
                CREATE INDEX IF NOT EXISTS events_vault_seq ON events(vault, seq);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.execute("PRAGMA synchronous=FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def handle(self, endpoint, body):
        require(isinstance(body, dict), "Expected an object")
        vault = body.get("vaultId")
        require(isinstance(vault, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", vault), "Invalid vault ID")
        if endpoint == "/v1/bootstrap":
            seed = body.get("seed")
            validate_event(seed, seed=True)
            payload = canonical(seed)
            digest = hashlib.sha256(payload.encode()).hexdigest()
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                previous = db.execute("SELECT seed_hash FROM vaults WHERE id=?", (vault,)).fetchone()
                if previous and previous[0] != digest:
                    raise ApiError(409, "This vault already has different history. Join it instead of importing again.")
                if not previous:
                    db.execute("INSERT INTO vaults VALUES (?, ?)", (vault, digest))
                    db.execute("INSERT INTO events(vault,id,payload) VALUES (?,?,?)", (vault, "seed", payload))
            return {"version": 1, "accepted": ["seed"], "events": [], "cursor": 0, "hasMore": False}
        if endpoint != "/v1/sync":
            raise ApiError(404, "Not found")
        cursor, events = body.get("cursor"), body.get("events")
        require(integer(cursor, 0), "Invalid cursor")
        require(isinstance(events, list) and len(events) <= 100, "At most 100 events per request")
        for event in events:
            validate_event(event)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM vaults WHERE id=?", (vault,)).fetchone():
                raise ApiError(404, "Vault not initialized. Import history on the first device.")
            latest = db.execute("SELECT COALESCE(MAX(seq),0) FROM events WHERE vault=?", (vault,)).fetchone()[0]
            if cursor > latest:
                raise ApiError(409, "Server history is older than this device. Restore the server backup before syncing.")
            for event in events:
                payload = canonical(event)
                existing = db.execute("SELECT payload FROM events WHERE vault=? AND id=?", (vault, event["id"])).fetchone()
                if existing and existing[0] != payload:
                    raise ApiError(409, "Event ID reused with different content")
                if not existing:
                    db.execute("INSERT INTO events(vault,id,payload) VALUES (?,?,?)", (vault, event["id"], payload))
            page = db.execute("SELECT seq,payload FROM events WHERE vault=? AND seq>? ORDER BY seq LIMIT 501", (vault, cursor)).fetchall()
            more = len(page) > 500
            page = page[:500]
            return {"version": 1, "accepted": [event["id"] for event in events],
                    "events": [{"seq": seq, "event": json.loads(payload)} for seq, payload in page],
                    "cursor": page[-1][0] if page else cursor, "hasMore": more}


def make_handler(store, token):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def reply(self, status, value):
            raw = canonical(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {"ok": True, "version": 1})
            else:
                self.reply(404, {"error": "Not found"})

        def do_POST(self):
            auth = self.headers.get("Authorization", "").encode()
            if not hmac.compare_digest(auth, f"Bearer {token}".encode()):
                self.reply(401, {"error": "Unauthorized"})
                return
            try:
                require(self.headers.get("Content-Type", "").split(";")[0] == "application/json", "Use application/json")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    raise ApiError(413, "Request body must be between 1 byte and 16 MiB")
                body = json.loads(self.rfile.read(length))
                self.reply(200, store.handle(self.path, body))
            except ApiError as error:
                self.reply(error.status, {"error": error.message})
            except (ValueError, UnicodeDecodeError):
                self.reply(400, {"error": "Invalid JSON or length"})
            except Exception:
                self.reply(500, {"error": "Server storage error"})

        def log_message(self, format, *args):
            # No headers, credentials, paths or writing statistics in logs.
            pass
    return Handler


def main():
    token = os.environ.get("KTR_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("Set KTR_TOKEN to a random token of at least 32 characters")
    store = EventStore(os.environ.get("KTR_DB", "/data/ktr.sqlite3"))
    server = ThreadingHTTPServer((os.environ.get("KTR_HOST", "0.0.0.0"), int(os.environ.get("KTR_PORT", "8080"))), make_handler(store, token))
    print("KTR server listening", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
