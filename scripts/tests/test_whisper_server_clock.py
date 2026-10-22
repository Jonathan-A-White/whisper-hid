"""Durations and deadlines in whisper-server.py must not follow the wall clock.

A phone (or WSL2) steps its wall clock; a latency taken as time.time() minus
time.time() then comes out negative or wrong, and a deadline loop on time.time()
ends early or never. The tests replace the server's `time` with a fake whose
time() steps by a fixed amount on every read (backwards or forwards) while
monotonic() moves only when the test or a fake sleep advances it.
"""

import importlib.util
import json
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _load_server_module():
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server_clock", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeTime:
    """A wall clock that steps `wall_step` seconds on every read."""

    MAX_SLEEPS = 1000  # a loop still running after this has lost its deadline

    def __init__(self, wall_step):
        self.wall = 1_000_000.0
        self.wall_step = wall_step
        self.mono = 5_000.0
        self.sleeps = 0

    def time(self):
        self.wall += self.wall_step
        return self.wall

    def monotonic(self):
        return self.mono

    def advance(self, seconds):
        self.mono += seconds

    def sleep(self, seconds):
        self.sleeps += 1
        if self.sleeps > self.MAX_SLEEPS:
            raise AssertionError("deadline loop never ended")
        self.mono += seconds


@pytest.fixture
def server(tmp_path):
    mod = _load_server_module()
    mod.CLEANUP_SETTINGS_FILE = str(tmp_path / "cleanup-settings.json")
    mod.CORRECTIONS_FILE = str(tmp_path / "word-corrections.json")
    mod.word_corrections = {}
    mod.symbol_settings = {"enabled": False, "entries": []}
    mod.app.config["TESTING"] = True
    return mod


@pytest.fixture
def clock(server):
    """The server's clock, stepping backwards 1000s on every wall-clock read."""
    fake = FakeTime(wall_step=-1000.0)
    server.time = fake
    return fake


def _logs(server):
    return [e["msg"] for e in server.log_buffer]


class TestLatenciesIgnoreTheWallClock:
    def test_cleanup_ms(self, server, clock):
        server.cleanup_settings = {"enabled": True}
        server._is_cleanup_server_alive = lambda: True

        def request(text):
            clock.advance(2.5)
            return "Hello there."

        server._cleanup_request = request
        server.apply_cleanup("um hello there")
        assert server.last_cleanup_ms == 2500

    def test_voice_edit_duration_ms(self, server, clock):
        server._is_cleanup_server_alive = lambda: True

        def request(text, command):
            clock.advance(1.25)
            return "Send the report to Sarah."

        server._edit_request = request
        resp = server.app.test_client().post(
            "/edit",
            data=json.dumps({"text": "Send the report to Mike.", "command": "replace Mike with Sarah"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["duration_ms"] == 1250

    def test_parakeet_duration_ms(self, server, clock):
        class Stream:
            result = types.SimpleNamespace(text=" hello ")

            def accept_waveform(self, rate, audio):
                clock.advance(0.5)

        class Recognizer:
            def create_stream(self):
                return Stream()

            def decode_stream(self, stream):
                clock.advance(0.75)

        server._parakeet_recognizer = Recognizer()
        server._read_wav_float32 = lambda path: ([0.0], 16000)
        text, ms = server.run_parakeet_raw("unused.wav")
        assert text == "hello"
        assert ms == 1250

    def test_parakeet_load_ms(self, server, clock):
        server._parakeet_recognizer = None
        server.find_parakeet_model_files = lambda: {"encoder": "e"}

        def create(files):
            clock.advance(1.5)
            return object(), "fake"

        server._create_parakeet_recognizer = create
        assert server.load_parakeet() is True
        assert any("loaded in 1500ms" in m for m in _logs(server))


class TestCleanupReadyDeadline:
    """The watcher waits 180s for the llama-server by the clock that cannot step."""

    @pytest.mark.parametrize("wall_step", [-1000.0, 10_000.0])
    def test_ends_after_its_span(self, server, wall_step, monkeypatch):
        fake = FakeTime(wall_step=wall_step)
        server.time = fake

        class Proc:
            pid = 1
            returncode = None

            def poll(self):
                return None

        class InlineThread:
            def __init__(self, target, args=(), **kwargs):
                self._target, self._args = target, args

            def start(self):
                self._target(*self._args)

        server.find_cleanup_bin = lambda: "/fake/llama-server"
        server.find_cleanup_model = lambda: "/fake/model.gguf"
        monkeypatch.setattr(server.subprocess, "Popen", lambda *a, **k: Proc())
        monkeypatch.setattr(server.threading, "Thread", InlineThread)
        server._cleanup_health_ok = lambda timeout=1.0: False

        assert server.start_cleanup_server() is True
        assert 179 <= fake.sleeps <= 181
        assert any("not ready after 180s" in m for m in _logs(server))


class TestReprobeIntervalIgnoresTheWallClock:
    def test_no_reprobe_inside_window_after_a_backwards_step(self, server, clock, monkeypatch):
        probes = []
        monkeypatch.setattr(server, "_termux_api_bin", None)
        monkeypatch.setattr(server, "_termux_api_probed_at", clock.mono)
        monkeypatch.setattr(server, "_detect_termux_api_bin", lambda: probes.append(1))
        clock.advance(server.TERMUX_API_REPROBE_SEC - 1)
        assert server._mic_source_selectable() is False
        assert probes == []
        clock.advance(2)
        server._mic_source_selectable()
        assert probes == [1]


class TestStampsStayOnTheWallClock:
    def test_log_ts_is_epoch_seconds(self, server):
        server.add_log("info", "stamp")
        assert abs(server.log_buffer[-1]["ts"] - __import__("time").time()) < 5
