"""Tests for scripts/bench-cleanup.sh (times each installed cleanup model).

The script is bash and talks to a llama-server it starts itself, so the tests
put a fake llama-server (a tiny Python HTTP server) where the real binary
lives and point WHISPER_INSTALL_DIR at a temp dir of fake GGUF files.
"""

import os
import shutil
import socket
import stat
import subprocess
import sys

import pytest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BENCH = os.path.join(SCRIPTS_DIR, "bench-cleanup.sh")

FAKE_LLAMA_SERVER = f"""#!{sys.executable}
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

args = sys.argv[1:]
port = int(args[args.index("--port") + 1])
model = os.path.basename(args[args.index("--model") + 1])
with open(os.environ["FAKE_LLAMA_LOG"], "a") as f:
    f.write(model + "\\n")
if model.startswith("Broken"):
    sys.exit(1)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self._send({{"status": "ok"}})
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self._send({{"choices": [{{"message": {{"content": "Cleaned."}}}}]}})

HTTPServer(("127.0.0.1", port), H).serve_forever()
"""


@pytest.fixture
def install(tmp_path):
    """A fake whisper-stt install dir with two models and a fake llama-server."""
    models = tmp_path / "models"
    models.mkdir()
    (models / "Qwen3-1.7B-Q4_K_M.gguf").write_bytes(b"\0" * (3 * 1024 * 1024))
    (models / "Qwen3.5-0.8B-Q4_K_M.gguf").write_bytes(b"\0" * (1024 * 1024))
    (models / "notes.txt").write_text("not a model")
    bindir = tmp_path / "llama.cpp" / "build" / "bin"
    bindir.mkdir(parents=True)
    server = bindir / "llama-server"
    server.write_text(FAKE_LLAMA_SERVER)
    server.chmod(server.stat().st_mode | stat.S_IXUSR)
    return tmp_path


def _free_port():
    """A port nobody holds right now (another session may hold the script's default)."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _run(install, *args, **env):
    full_env = {
        **os.environ,
        "WHISPER_INSTALL_DIR": str(install),
        "FAKE_LLAMA_LOG": str(install / "llama.log"),
        "BENCH_PORT": str(_free_port()),
        "BENCH_RUNS": "1",
        **env,
    }
    return subprocess.run(
        ["bash", BENCH, *args],
        capture_output=True, text=True, env=full_env, timeout=120,
    )


def _started(install):
    log = install / "llama.log"
    return log.read_text().split() if log.exists() else []


def test_script_exists_and_is_executable():
    assert os.path.isfile(BENCH)
    assert os.stat(BENCH).st_mode & stat.S_IXUSR


def test_dry_run_prints_plan_without_starting_a_server(install):
    r = _run(install, "--dry-run")
    assert r.returncode == 0, r.stderr
    assert "Qwen3-1.7B-Q4_K_M.gguf" in r.stdout
    assert "Qwen3.5-0.8B-Q4_K_M.gguf" in r.stdout
    assert "notes.txt" not in r.stdout
    assert "3 MB" in r.stdout and "1 MB" in r.stdout
    for prompt in ("short", "20-second", "60-second"):
        assert prompt in r.stdout
    assert "dry run" in r.stdout.lower()
    assert _started(install) == []


def test_dry_run_needs_no_llama_server_binary(install):
    os.remove(install / "llama.cpp" / "build" / "bin" / "llama-server")
    r = _run(install, "--dry-run")
    assert r.returncode == 0, r.stderr
    assert "Qwen3-1.7B-Q4_K_M.gguf" in r.stdout


def test_no_models_installed_fails_with_a_hint(tmp_path):
    (tmp_path / "models").mkdir()
    r = _run(tmp_path, "--dry-run")
    assert r.returncode != 0
    assert "update-model.sh" in (r.stdout + r.stderr)


def test_unknown_argument_is_refused(install):
    r = _run(install, "--bogus")
    assert r.returncode != 0
    assert _started(install) == []


def test_real_run_prints_one_row_per_model(install):
    r = _run(install)
    assert r.returncode == 0, r.stderr
    assert sorted(_started(install)) == ["Qwen3-1.7B-Q4_K_M.gguf", "Qwen3.5-0.8B-Q4_K_M.gguf"]
    rows = [l for l in r.stdout.splitlines() if l.startswith("Qwen")]
    assert len(rows) == 2
    # model, MB, load s, then the timings: all numeric
    for row in rows:
        cols = row.split()
        assert cols[1] in ("3", "1")
        assert all(float(c) >= 0 for c in cols[2:])


def test_a_model_that_will_not_load_is_reported_and_the_rest_still_run(install):
    (install / "models" / "Broken-Q4_K_M.gguf").write_bytes(b"\0" * (1024 * 1024))
    r = _run(install, BENCH_LOAD_TIMEOUT="5")
    assert r.returncode == 0, r.stderr
    broken = [l for l in r.stdout.splitlines() if l.startswith("Broken")]
    assert len(broken) == 1 and "failed" in broken[0].lower()
    assert len([l for l in r.stdout.splitlines() if l.startswith("Qwen")]) == 2


def test_leaves_nothing_running_on_the_bench_port(install):
    port = _free_port()
    _run(install, BENCH_PORT=str(port))
    if shutil.which("ss"):
        out = subprocess.run(["ss", "-ltn"], capture_output=True, text=True).stdout
        assert f":{port} " not in out
