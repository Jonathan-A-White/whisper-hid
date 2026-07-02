"""Tests for chunked (streaming) transcription.

Covers the silence-boundary detection, WAV helpers, the ChunkedSession
poller (with the decode and engine steps mocked), and the stop-time
assembly — including that corrections/symbols run once over the joined
text so phrases spanning a chunk boundary still match.
"""

import importlib.util
import math
import os
import sys
import wave

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

FRAME = 0.03  # analysis frame seconds (CHUNK_FRAME_SEC)
SPEECH = 2000.0
SILENCE = 10.0


def _load_server_module():
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server_chunked", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def server():
    return _load_server_module()


def frames(seconds: float) -> int:
    return round(seconds / FRAME)


def levels_of(*segments) -> list[float]:
    """Build a levels list from (level, seconds) segments."""
    out = []
    for level, seconds in segments:
        out.extend([level] * frames(seconds))
    return out


def write_wav(path: str, *segments, rate: int = 16000):
    """Write a 16kHz mono WAV from (amplitude, seconds) segments.

    Nonzero amplitude produces a 440Hz tone; zero produces silence.
    """
    samples = []
    for amp, seconds in segments:
        n = int(seconds * rate)
        if amp == 0:
            samples.extend([0] * n)
        else:
            samples.extend(int(amp * math.sin(2 * math.pi * 440 * i / rate)) for i in range(n))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        import array

        w.writeframes(array.array("h", samples).tobytes())


class TestFindCommitBoundary:
    def test_boundary_at_silence_between_speech(self, server):
        # 2s speech, 1s silence, 1s speech (+ tail padding past the guard)
        levels = levels_of((SPEECH, 2.0), (SILENCE, 1.0), (SPEECH, 1.0))
        found = server.find_commit_boundary(levels, FRAME, 0.0, len(levels) * FRAME)
        assert found is not None
        boundary, has_speech = found
        assert 2.3 <= boundary <= 2.7  # midpoint of the 2.0-3.0s silence run
        assert has_speech is True

    def test_pure_silence_advances_without_speech(self, server):
        levels = levels_of((SILENCE, 5.0))
        found = server.find_commit_boundary(levels, FRAME, 0.0, 5.0)
        assert found is not None
        boundary, has_speech = found
        assert boundary > 1.0
        assert has_speech is False

    def test_short_pause_is_not_a_boundary(self, server):
        # 0.3s pause is below CHUNK_SILENCE_SEC
        levels = levels_of((SPEECH, 2.0), (SILENCE, 0.3), (SPEECH, 2.0))
        assert server.find_commit_boundary(levels, FRAME, 0.0, len(levels) * FRAME) is None

    def test_no_new_boundary_after_committed(self, server):
        levels = levels_of((SPEECH, 2.0), (SILENCE, 1.0), (SPEECH, 1.0))
        total = len(levels) * FRAME
        first = server.find_commit_boundary(levels, FRAME, 0.0, total)
        assert first is not None
        # Nothing new after committing up to the boundary
        assert server.find_commit_boundary(levels, FRAME, first[0], total) is None

    def test_tail_guard_excludes_trailing_silence(self, server):
        # Silence only in the final 0.5s; the 0.4s tail guard leaves a
        # 0.1s run — too short to qualify.
        levels = levels_of((SPEECH, 2.0), (SILENCE, 0.5))
        assert server.find_commit_boundary(levels, FRAME, 0.0, len(levels) * FRAME) is None

    def test_ongoing_pause_at_end_commits(self, server):
        # User is mid-thinking-pause: silence extends to the end of the
        # decoded audio. Should still commit (run truncated at the guard).
        levels = levels_of((SPEECH, 2.0), (SILENCE, 3.0))
        found = server.find_commit_boundary(levels, FRAME, 0.0, len(levels) * FRAME)
        assert found is not None
        boundary, has_speech = found
        assert boundary > 2.0
        assert has_speech is True

    def test_empty_levels(self, server):
        assert server.find_commit_boundary([], FRAME, 0.0, 0.0) is None


class TestWavHelpers:
    def test_frame_levels_distinguish_tone_and_silence(self, server, tmp_path):
        wav = str(tmp_path / "a.wav")
        write_wav(wav, (3000, 0.5), (0, 0.5))
        pcm, rate = server._read_wav_pcm(wav)
        assert rate == 16000
        levels = server._frame_levels(pcm, rate)
        assert len(levels) == pytest.approx(33, abs=2)
        assert levels[2] > 1000   # tone region
        assert levels[-2] < 5     # silence region

    def test_write_wav_slice(self, server, tmp_path):
        src = str(tmp_path / "src.wav")
        dst = str(tmp_path / "dst.wav")
        write_wav(src, (3000, 1.0))
        sec = server._write_wav_slice(src, dst, 0.25, 0.75)
        assert sec == pytest.approx(0.5, abs=0.01)
        with wave.open(dst, "rb") as w:
            assert w.getnframes() == pytest.approx(8000, abs=2)

    def test_write_wav_slice_open_end_and_clamping(self, server, tmp_path):
        src = str(tmp_path / "src.wav")
        dst = str(tmp_path / "dst.wav")
        write_wav(src, (3000, 1.0))
        assert server._write_wav_slice(src, dst, 0.5, None) == pytest.approx(0.5, abs=0.01)
        # Start beyond the end clamps to an empty slice, not an error
        assert server._write_wav_slice(src, dst, 5.0, None) == 0.0


class TestCleanRawText:
    def test_strips_markers_and_whitespace(self, server):
        assert server._clean_raw_text(" hello  [BLANK_AUDIO] world\n") == "hello world"

    def test_no_corrections_applied(self, server):
        server.word_corrections = {"quad": "Claude"}
        assert server._clean_raw_text("ask quad") == "ask quad"


class TestChunkedSession:
    def _mock_decode(self, server, prepared_wav):
        """Make transcode_to_wav 'decode' any input to the prepared WAV."""

        def fake_transcode(input_path, output_path, quiet=False):
            import shutil

            shutil.copyfile(prepared_wav, output_path)
            return True

        server.transcode_to_wav = fake_transcode

    def test_poll_commits_chunk(self, server, tmp_path):
        rec = str(tmp_path / "rec.aac")
        with open(rec, "wb") as f:
            f.write(b"\0" * 8192)  # size gate only; decode is mocked
        prepared = str(tmp_path / "partial.wav")
        # 1.5s speech, 1s pause, 0.5s speech (still being spoken)
        write_wav(prepared, (3000, 1.5), (0, 1.0), (3000, 0.5))
        self._mock_decode(server, prepared)

        calls = []

        def fake_engine(wav_path, postprocess=True):
            calls.append((wav_path, postprocess))
            return "hello there", 42

        server.run_transcription = fake_engine

        session = server.ChunkedSession(rec)
        session._poll_once()

        assert session.texts == ["hello there"]
        assert session.chunks == 1
        assert session.engine_ms == 42
        assert 1.7 <= session.committed_sec <= 2.3  # middle of the pause
        assert calls[0][1] is False  # raw mode — postprocess happens once at stop

        # Same audio again: no new boundary, no state change
        session._poll_once()
        assert session.chunks == 1

    def test_poll_skips_silent_chunk(self, server, tmp_path):
        rec = str(tmp_path / "rec.aac")
        with open(rec, "wb") as f:
            f.write(b"\0" * 8192)
        prepared = str(tmp_path / "partial.wav")
        write_wav(prepared, (0, 4.0))  # user thinking, nothing said yet
        self._mock_decode(server, prepared)

        def fail_engine(wav_path, postprocess=True):
            raise AssertionError("engine must not run on silence")

        server.run_transcription = fail_engine

        session = server.ChunkedSession(rec)
        session._poll_once()
        assert session.texts == []
        assert session.committed_sec > 1.0  # advanced past the silence

    def test_poll_ignores_missing_or_tiny_file(self, server, tmp_path):
        session = server.ChunkedSession(str(tmp_path / "nope.aac"))
        session._poll_once()  # must not raise
        assert session.committed_sec == 0.0

    def test_has_results(self, server, tmp_path):
        session = server.ChunkedSession(str(tmp_path / "r.aac"))
        assert not session.has_results()
        session.texts.append("hi")
        assert session.has_results()

    def test_finish_stops_thread(self, server, tmp_path):
        session = server.ChunkedSession(str(tmp_path / "r.aac"))
        session.start()
        assert session.finish(timeout=5.0) is True


class TestFinishChunked:
    def test_joins_chunks_and_tail_and_postprocesses_once(self, server, tmp_path):
        full = str(tmp_path / "full.wav")
        write_wav(full, (3000, 3.0))

        def fake_engine(wav_path, postprocess=True):
            assert postprocess is False
            return "slash help", 10

        server.run_transcription = fake_engine
        server.word_corrections = {"ford": "forward"}
        # Symbol phrase spans the chunk/tail boundary: "forward slash" is
        # split as chunk="... ford" (misheard) + tail="slash help".
        server.symbol_settings = {
            "enabled": True,
            "entries": [{"phrase": "forward slash", "symbol": "/", "spacing": "right"}],
        }

        session = server.ChunkedSession(str(tmp_path / "r.aac"))
        session.texts = ["please run ford"]
        session.committed_sec = 2.0
        session.engine_ms = 40
        session.chunks = 1

        text, ms = server._finish_chunked_transcription(session, full)
        # correction (ford->forward) then symbol (forward slash -> /) applied
        # across the chunk boundary — only possible because postprocess runs
        # once over the joined text.
        assert text == "please run /help"
        assert ms == 50

    def test_empty_tail(self, server, tmp_path):
        full = str(tmp_path / "full.wav")
        write_wav(full, (3000, 2.0))

        def fail_engine(wav_path, postprocess=True):
            raise AssertionError("no tail to transcribe")

        server.run_transcription = fail_engine
        server.word_corrections = {}
        server.symbol_settings = {"enabled": False, "entries": []}

        session = server.ChunkedSession(str(tmp_path / "r.aac"))
        session.texts = ["all committed"]
        session.committed_sec = 1.98  # tail < 0.1s — skip the engine
        session.engine_ms = 30

        text, ms = server._finish_chunked_transcription(session, full)
        assert text == "all committed"
        assert ms == 30
