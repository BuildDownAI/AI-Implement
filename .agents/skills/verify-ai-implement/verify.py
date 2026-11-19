#!/usr/bin/env python3
"""Drive the local orchestrator through its published admin HTTP interface."""
import argparse
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("feature", choices=["login", "mappings", "log"])
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
for port in [9070, 8081, 5122, 9080, 17941]:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))
proof = Path(tempfile.mkdtemp(prefix="ai-implement-proof-"))
print(proof, flush=True)
code = secrets.token_urlsafe()
token = None


def request(method, path, body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn = http.client.HTTPConnection("127.0.0.1", 17941, timeout=4)
    try:
        conn.request(method, path, json.dumps(body) if body else None, headers)
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def check(method, path, expected, body=None):
    status, raw = request(method, path, body)
    value = json.loads(raw)
    safe = {"token": "[redacted]"} if "token" in value else value
    with (proof / "http.jsonl").open("a") as trace:
        print(json.dumps(dict(method=method, path=path, status=status, response=safe)), file=trace)
    assert status == expected, (path, status)
    return value


with tempfile.TemporaryDirectory() as scratch, (proof / "service.log").open("w") as log:
    env = dict(PATH=os.environ["PATH"], HOME=scratch, PORT="17941", ADMIN_ACCESS_CODE=code,
               DEDUP_DB_PATH=f"{scratch}/dedup.sqlite", GITHUB_APP_ID="1",
               GITHUB_APP_PRIVATE_KEY=subprocess.check_output(["openssl", "genrsa", "2048"], text=True))
    proc = subprocess.Popen([shutil.which("node"), root / "dist/index.js"], cwd=scratch,
                            env=env, stdout=log, stderr=log, start_new_session=True)
    try:
        for _ in range(180):
            assert proc.poll() is None, f"Boot failed: {proof}/service.log"
            try:
                status, page = request("GET", "/admin")
                if status == 200 and b"<html" in page.lower():
                    break
            except OSError:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError(f"Admin page unavailable: {proof}/service.log")
        if args.feature == "login":
            check("POST", "/api/auth", 403, {"code": "wrong"})
        token = check("POST", "/api/auth", 200, {"code": code})["token"]
        assert token
        # Read-only doctor also proves the session has access to this fresh database.
        assert check("GET", "/api/mappings", 200) == {}
        if args.feature == "log":
            for path in ["/api/log", "/api/log?since=0&until=1"]:
                assert check("GET", path, 200) == []
    finally:
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
