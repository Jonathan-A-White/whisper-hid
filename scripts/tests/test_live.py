"""Tests for GET /transcribe/live — the words Parakeet has so far while recording.

A fake engine and a mocked decode stand in for the model and ffmpeg. The
tentative tail runs in its own thread, so tests join `session._tail_thread`
before reading the result.
"""

import importlib.util
import os
import shutil
import sys
import threading
import time
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from .test_chunked import write_wav  # noqa: E402


def _load_server_module():
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server_live", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def server():
    mod = _load_server_module()
    mod.word_corrections = {}
    mod.symbol_settings = {"enabled": False, "entries": []}
    return mod


class FakeEngine:
    """Answers by which kind of job the WAV is: a committed chunk, the live
    tentative tail, or Stop's final tail."""

    def __init__(self, chunk_texts, live_text="tentative words", live_gate=None):
        self.chunk_texts = list(chunk_texts)
        self.live_text = live_text
        self.live_gate = live_gate  # Event: the live job blocks until it is set
        self.live_calls = 0

    def __call__(self, wav_path, postprocess=True):
        assert postprocess is False
        if wav_path.endswith(".live.wav"):
            self.live_calls += 1
            if self.live_gate is not None:
                self.live_gate.wait(5.0)
            return self.live_text, 5
        if wav_path.endswith(".tail.wav"):
            return "final tail", 7
        return self.chunk_texts.pop(0), 11


def _install(server, tmp_path, engine, *segments):
    """Mock decode to a prepared WAV and the engine to `engine`. Returns the
    recording path; `grow(path, *segments)` swaps in a longer 'recording'."""
    prepared = str(tmp_path / "partial.wav")
    write_wav(prepared, *segments)

    def fake_transcode(input_path, output_path, quiet=False):
        shutil.copyfile(prepared, output_path)
        return True

    server.transcode_to_wav = fake_transcode
    server.run_transcription = engine
    rec = str(tmp_path / "rec.aac")
    with open(rec, "wb") as f:
        f.write(b"\0" * 8192)
    return rec


def _join_tail(session):
    t = session._tail_thread
    if t is not None:
        t.join(timeout=5.0)


# The recording as it grows (the poller commits up to the LAST long pause):
# poll 1 commits phrase one, poll 2 phrase two, poll 3 sees 1.2s still being said.
ONE_PHRASE = ((3000, 1.5), (0, 1.5), (3000, 1.0))
TWO_PHRASES = ((3000, 1.5), (0, 1.5), (3000, 1.5), (0, 1.5), (3000, 1.2))
STAGES = (ONE_PHRASE, TWO_PHRASES, TWO_PHRASES)


def _grow(tmp_path, segments):
    write_wav(str(tmp_path / "partial.wav"), *segments)


class TestLiveEndpoint:
    def test_not_recording(self, server):
        server.chunked_supported = True
        body = server.app.test_client().get("/transcribe/live").get_json()
        assert body["recording"] is False
        assert body["text"] == ""
        assert body["tail"] == ""
        assert body["seq"] == 0

    def test_two_chunks_and_a_tail(self, server, tmp_path):
        engine = FakeEngine(["first phrase", "second phrase"])
        rec = _install(server, tmp_path, engine, *ONE_PHRASE)
        server.chunked_supported = True
        server.recording_process = object()
        session = server.ChunkedSession(rec)
        server.chunk_session = session
        client = server.app.test_client()

        seqs = []
        for stage in STAGES:
            _grow(tmp_path, stage)
            session._poll_once()
            _join_tail(session)
            seqs.append(client.get("/transcribe/live").get_json()["seq"])

        body = client.get("/transcribe/live").get_json()
        assert body["recording"] is True
        assert body["chunked"] is True
        assert body["text"] == "first phrase second phrase"
        assert body["tail"] == "tentative words"
        # seq rose on each change (chunk 1, chunk 2, then the tail appeared)
        assert seqs[0] < seqs[1] < seqs[2]
        assert body["seq"] == seqs[2]

        # Nothing changed: another poll leaves seq alone
        session._poll_once()
        _join_tail(session)
        assert client.get("/transcribe/live").get_json()["seq"] == seqs[2]

    def test_tail_changing_bumps_seq(self, server, tmp_path):
        engine = FakeEngine([])
        rec = _install(server, tmp_path, engine, (3000, 3.0))
        server.chunked_supported = True
        server.recording_process = object()
        session = server.ChunkedSession(rec)
        server.chunk_session = session
        client = server.app.test_client()

        session._poll_once()
        _join_tail(session)
        first = client.get("/transcribe/live").get_json()
        assert first["tail"] == "tentative words"
        engine.live_text = "tentative words grown"
        session._poll_once()
        _join_tail(session)
        second = client.get("/transcribe/live").get_json()
        assert second["tail"] == "tentative words grown"
        assert second["seq"] > first["seq"]

    def test_no_tail_under_one_second_of_new_audio(self, server, tmp_path):
        engine = FakeEngine([])
        rec = _install(server, tmp_path, engine, (3000, 0.7))
        server.chunked_supported = True
        server.recording_process = object()
        session = server.ChunkedSession(rec)
        server.chunk_session = session

        session._poll_once()
        _join_tail(session)
        assert engine.live_calls == 0
        assert server.app.test_client().get("/transcribe/live").get_json()["tail"] == ""

    def test_no_tail_while_engine_busy(self, server, tmp_path):
        engine = FakeEngine([])
        rec = _install(server, tmp_path, engine, (3000, 3.0))
        server.chunked_supported = True
        session = server.ChunkedSession(rec)
        with server.transcribe_lock:
            session._poll_once()
        assert engine.live_calls == 0

    def test_chunked_unsupported(self, server):
        server.chunked_supported = False
        server.recording_process = object()
        server.chunk_session = None
        body = server.app.test_client().get("/transcribe/live").get_json()
        assert body["recording"] is True
        assert body["chunked"] is False
        assert body["text"] == ""
        assert body["tail"] == ""


class _RealClock:
    """The server's `time`, minus the 2s settle sleep in Stop."""

    def __getattr__(self, name):
        return getattr(time, name)

    @staticmethod
    def sleep(_s):
        pass


def _stop_scenario(server, tmp_path, engine, with_live_calls):
    """Record two chunks plus a live tail, then Stop. Returns (raw body, secs, session)."""
    rec = _install(server, tmp_path, engine, *ONE_PHRASE)
    server.chunked_supported = True
    server.recording_process = object()
    server.recording_file = rec
    session = server.ChunkedSession(rec)
    server.chunk_session = session
    session.start()
    client = server.app.test_client()
    for stage in STAGES:
        _grow(tmp_path, stage)
        session._poll_once()
        if with_live_calls:
            client.get("/transcribe/live")
    server.subprocess = types.SimpleNamespace(
        run=lambda *a, **k: types.SimpleNamespace(returncode=0, stdout=""),
        TimeoutExpired=server.subprocess.TimeoutExpired,
        Popen=server.subprocess.Popen,
    )
    server.time = _RealClock()
    t0 = time.monotonic()
    resp = client.post("/transcribe/stop")
    return resp.data, time.monotonic() - t0, session


class TestStopUnaffected:
    def test_stop_text_is_byte_identical_with_live_calls(self, server, tmp_path):
        (tmp_path / "a").mkdir()
        (tmp_path / "b").mkdir()
        plain, _, _ = _stop_scenario(
            server, tmp_path / "a", FakeEngine(["first phrase", "second phrase"]), False
        )
        server = _load_server_module()
        server.word_corrections = {}
        server.symbol_settings = {"enabled": False, "entries": []}
        live, _, _ = _stop_scenario(
            server, tmp_path / "b", FakeEngine(["first phrase", "second phrase"]), True
        )
        assert b"First phrase. Second phrase. Final tail." in plain
        assert live == plain

    def test_stop_does_not_wait_for_a_running_tail_job(self, server, tmp_path):
        gate = threading.Event()
        engine = FakeEngine(["first phrase", "second phrase"], live_gate=gate)
        try:
            body, secs, session = _stop_scenario(server, tmp_path, engine, True)
            assert engine.live_calls == 1  # the tail job really was in flight
            assert secs < 1.0, f"Stop took {secs:.1f}s with a tail job running"
            assert b"First phrase. Second phrase. Final tail." in body
            assert b"tentative" not in body
        finally:
            gate.set()
        _join_tail(session)
        assert session.tail == ""  # the discarded job never lands
