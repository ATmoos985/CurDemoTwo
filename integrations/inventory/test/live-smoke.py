"""Isolated final-JAR delivery smoke. Python stdlib only; never connects to port 8080.

Run after `sh mvnw verify`: python3 integrations/inventory/test/live-smoke.py
Evidence and temporary inventory are retained in the printed directory; no credentials are saved.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
JAR = ROOT / "target/CutDemoTwo-0.0.1-SNAPSHOT.jar"
QA = Path(tempfile.mkdtemp(prefix="cutdemo-outbox-smoke-"))
STATE = QA / "stock.json"
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    PORT = probe.getsockname()[1]
BASE = f"http://127.0.0.1:{PORT}"
TOKEN = secrets.token_urlsafe(48)
process = None
passed = 0
fixtures = []


def call(path, body=None, expected=200, auth=True, schema=None):
    headers = {"Content-Type": "application/json"}
    if auth:
        headers["Authorization"] = "Bearer " + TOKEN
    request = urllib.request.Request(BASE + path, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    assert status == expected, (path, status, raw)
    value = json.loads(raw)
    if schema:
        fixtures.append({"schema": schema, "value": value})
    return value


def start():
    global process
    env = dict(os.environ, CUTDEMO_INTEGRATION_ENABLED="true", CUTDEMO_INTEGRATION_TOKEN=TOKEN,
               CUTDEMO_INTEGRATION_LEASE_SECONDS="2")
    with (QA / "server.log").open("ab") as log:
        process = subprocess.Popen(["java", "-jar", str(JAR), f"--server.port={PORT}",
            "--cutdemo.storage=file", "--cutdemo.jobs.storage=file", "--cutdemo.jobs.import-path=",
            "--server.address=127.0.0.1", f"--cutdemo.state.path={STATE}",
            f"--cutdemo.jobs.path={QA / 'jobs'}", f"--cutdemo.integration.path={QA / 'delivery'}",
            "--cutdemo.seed-demo-data=true"], cwd=ROOT, env=env, stdout=log, stderr=log)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        assert process.poll() is None, "QA server stopped; inspect server.log"
        try:
            if call("/api/health")["status"] == "UP":
                return
        except (OSError, urllib.error.URLError):
            time.sleep(.15)
    raise AssertionError("QA startup timed out")


def stop():
    if process is not None and process.poll() is None:
        process.terminate()
        process.wait(timeout=30)


def check(name):
    global passed
    passed += 1
    print("PASS " + name, flush=True)


PREFIX = "/api/v2/integration-deliveries"


def claim(key, retry=None, expected=200):
    body = {"requestId": key}
    if retry is not None:
        body["retryOf"] = retry
    return call(PREFIX + "/claims", body, expected, schema="IntegrationLease" if expected == 200 else None)


def ack(lease, status="ACCEPTED", receipt="WMS-receipt", expected=200):
    body = {"token": lease["attempt"]["token"], "status": status}
    body["externalReceipt" if status == "ACCEPTED" else "reason"] = receipt
    return call(PREFIX + "/" + lease["event"]["id"] + "/acknowledgements", body,
                expected, schema="IntegrationDelivery" if expected == 200 else None)


try:
    start()
    assert call(PREFIX, auth=False, expected=401)["code"] == "UNAUTHORIZED"
    assert claim("empty")["state"] == "EMPTY"
    assert call(PREFIX)["items"] == []
    check("authentication and demo startup produce no historical events")

    for material in ["REM-202609-001", "REM-202609-002"]:
        assert call(f"/api/remnants/{material}/scrap", {"reason": "isolated integration smoke"})["success"]
    before = STATE.read_bytes()
    page = call(PREFIX, schema="IntegrationDeliveryPage")
    assert [item["sequence"] for item in page["items"]] == [1, 2]
    first = claim("unknown-response")
    assert first == claim("unknown-response")
    assert claim("competing", expected=409)["code"] == "DELIVERY_BUSY"
    check("committed facts are ordered; unknown claim response replays the same attempt")

    # Stand-in external receiver: its dedupe identity, receipt and application marker commit together.
    external = sqlite3.connect(QA / "external.sqlite")
    external.execute("CREATE TABLE applied (event_id TEXT PRIMARY KEY, payload_hash TEXT, receipt TEXT)")

    def receive(lease):
        event = lease["event"]
        digest = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()
        receipt = "WMS-" + event["id"]
        with external:
            external.execute("INSERT OR IGNORE INTO applied VALUES (?, ?, ?)", (event["id"], digest, receipt))
            row = external.execute("SELECT payload_hash, receipt FROM applied WHERE event_id=?", (event["id"],)).fetchone()
            assert row[0] == digest, "same event identity changed payload"
            return row[1]

    receipt = receive(first)  # External commit succeeds, but its acknowledgement is lost.
    time.sleep(max(0, first["attempt"]["expiresAt"] / 1000 - time.time()) + .1)
    assert claim("unknown-response")["state"] == "EXPIRED"
    assert ack(first, receipt=receipt, expected=409)["code"] == "STALE_ATTEMPT"
    replacement = claim("after-expiry")
    assert replacement["event"] == first["event"]
    assert receive(replacement) == receipt
    assert external.execute("SELECT count(*) FROM applied").fetchone()[0] == 1
    confirmed = ack(replacement, receipt=receipt)
    assert confirmed == ack(replacement, receipt=receipt)
    check("expired token is fenced; external commit plus lost response is applied only once")

    second = claim("rejected-first")
    rejected = ack(second, "REJECTED", "mapping missing")
    assert claim("implicit-retry", expected=409)["code"] == "DELIVERY_REJECTED"
    retry = claim("explicit-retry", second["attempt"]["token"])
    assert ack(second, "REJECTED", "mapping missing") == rejected
    assert call(PREFIX)["items"][1]["state"] == "LEASED"
    check("rejection blocks sequence; explicit retry survives late rejection replay")
    assert STATE.read_bytes() == before
    check("all delivery actions leave inventory bytes unchanged")

    stop()
    start()
    after_restart = STATE.read_bytes()
    assert claim("explicit-retry", second["attempt"]["token"])["event"] == second["event"]
    assert call(PREFIX)["acknowledgedThrough"] == 1
    # Startup may outlast the short lease: use a new identity only after expiry.
    remaining = retry["attempt"]["expiresAt"] / 1000 - time.time()
    if remaining >= 0:
        time.sleep(remaining + .1)
    final_attempt = claim("restart-retry")
    assert ack(retry, expected=409)["code"] == "STALE_ATTEMPT"
    ack(final_attempt, receipt=receive(final_attempt))
    assert claim("all-done")["state"] == "EMPTY"
    assert call(PREFIX, schema="IntegrationDeliveryPage")["acknowledgedThrough"] == 2
    assert STATE.read_bytes() == after_restart
    assert external.execute("SELECT count(*) FROM applied").fetchone()[0] == 2
    external.close()
    check("process restart preserves checkpoint, attempts and external deduplication")
    call("/api/cutting/tasks", {"name": "isolated task", "materialModel": "QA", "revision": 0,
        "demands": [{"id": 1, "name": "piece", "width": 100, "length": 100,
                     "quantity": 1, "allowRotation": False}]})
    task_event = claim("new-task")
    assert task_event["event"]["businessId"] is None
    assert all(isinstance(change["businessId"], str) for change in task_event["event"]["changes"])
    ack(task_event, receipt="WMS-task")
    check("new task top-level optional business id retains canonical ledger identity")
    (QA / "responses.json").write_text(json.dumps(fixtures, ensure_ascii=False))
    print(json.dumps({"executed": passed, "passed": passed, "failed": 0, "skipped": 0, "evidence": str(QA)}))
except Exception:
    print(json.dumps({"executed": passed + 1, "passed": passed, "failed": 1, "skipped": 0, "evidence": str(QA)}), flush=True)
    raise
finally:
    stop()
