"""Preview/import an existing KTR 0.2 data.json. Never merges two histories."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from server import canonical, validate_event


def prepare(source):
    data = json.loads(Path(source).read_text(encoding="utf-8"))
    if data.get("schema") != "0.2":
        raise ValueError("Expected schema 0.2. Open older data with KTR 0.2.16 and export it first.")
    rows = data.get("stats", {}).get("dailyActivity")
    if not isinstance(rows, list):
        raise ValueError("Missing stats.dailyActivity")
    seed = {"id": "seed", "kind": "seed", "clock": 0,
            "rows": [{key: value for key, value in row.items() if key != "id"} for row in rows]}
    validate_event(seed, seed=True)
    return seed


def summary(seed):
    rows = seed["rows"]
    changes = [change for row in rows for change in row["changes"]]
    dates = sorted(row["date"] for row in rows)
    return {"rows": len(rows), "time_entries": len(changes),
            "first_date": dates[0] if dates else None, "last_date": dates[-1] if dates else None,
            "words_delta": sum(change["w"] for change in changes),
            "characters_delta": sum(change["c"] for change in changes),
            "start_words": sum(row["wordCountStart"] for row in rows),
            "start_characters": sum(row["charCountStart"] for row in rows)}


def post(url, token, endpoint, body):
    request = urllib.request.Request(url + endpoint, data=canonical(body).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    # Never forward the bearer token to another origin through redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(request, timeout=60) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--server")
    parser.add_argument("--vault", default="writing")
    parser.add_argument("--apply", action="store_true", help="Back up locally, then import into an empty server vault")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    seed = prepare(args.source)
    expected = summary(seed)
    print(json.dumps(expected, ensure_ascii=False, indent=2))
    if not args.apply:
        print("Preview only. No files changed; no network request made.")
        return
    token = os.environ.get("KTR_TOKEN", "")
    if not args.server or len(token) < 32:
        raise ValueError("Set --server and KTR_TOKEN (at least 32 characters).")
    url = urllib.parse.urlsplit(args.server)
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("Use HTTPS except for localhost testing.")
    if url.username or url.password or url.query or url.fragment:
        raise ValueError("Server URL must not contain credentials, query or fragment.")
    backup = args.backup or args.source.with_name(args.source.name + ".pre-vps-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".bak")
    with backup.open("xb") as target, args.source.open("rb") as source:
        shutil.copyfileobj(source, target)
    print("Backup:", backup)
    base = args.server.rstrip("/")
    post(base, token, "/v1/bootstrap", {"vaultId": args.vault, "seed": seed})
    response = post(base, token, "/v1/sync", {"vaultId": args.vault, "cursor": 0, "events": []})
    imported = next((item["event"] for item in response["events"] if item["event"]["kind"] == "seed"), None)
    if imported is None or canonical(imported) != canonical(seed):
        raise ValueError("Server verification failed. Keep the backup and investigate before joining.")
    print("Verified: every imported field matches, including dates, paths and counts.")
    print("On ALL devices choose 'Join existing history'; do not import again.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Migration stopped:", str(error), file=sys.stderr)
        sys.exit(1)
