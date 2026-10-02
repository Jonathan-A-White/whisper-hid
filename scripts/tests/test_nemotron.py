"""Tests for the Nemotron Speech Streaming engine.

Two layers, like test_parakeet.py:
  * nemotron_onnx.NemotronRecognizer (the cache-aware RNNT loop) against fake
    onnxruntime sessions — needs numpy, skipped where it is absent (the gate
    venv); no model download.
  * the server wiring (GET /models, PUT /model, /status, decode dispatch)
    against a stub recognizer injected as the nemotron_onnx module.
A real-model test runs only when NEMOTRON_MODEL_DIR is set.
"""

import importlib.util
import json
import math
import os
import struct
import sys
import types
import wave

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

DIR_NAME = "sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25"


def _load_server_module():
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write_nemotron_model(model_dir):
    """Create fake Nemotron model files on disk."""
    base = model_dir / DIR_NAME
    base.mkdir(parents=True)
    for part in ["encoder", "decoder", "joiner"]:
        (base / f"{part}.int8.onnx").write_bytes(b"\x00" * 1024)
    (base / "tokens.txt").write_text("<unk> 0\n▁hi 1\n<blk> 2\n")
    return base


def write_wav(path, num_samples=1600, sample_rate=16000, value=1000):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(struct.pack(f"<{num_samples}h", *([value] * num_samples)))


# ---------------------------------------------------------------------------
# Server wiring (no numpy needed)
# ---------------------------------------------------------------------------

class StubNemotron:
    """Stands in for nemotron_onnx.NemotronRecognizer."""

    def __init__(self, model_dir, num_threads=4, text=" hello from nemotron "):
        self.model_dir = model_dir
        self.num_threads = num_threads
        self.text = text
        self.calls = []

    def transcribe(self, audio, sample_rate=16000):
        self.calls.append((len(audio), sample_rate))
        return self.text


def make_stub_module(text=" hello from nemotron ", load_error=None):
    mod = types.ModuleType("nemotron_onnx")

    def factory(model_dir, num_threads=4):
        if load_error is not None:
            raise load_error
        return StubNemotron(model_dir, num_threads, text)

    mod.NemotronRecognizer = factory
    return mod


@pytest.fixture
def server(tmp_path):
    saved = {n: sys.modules.pop(n, None) for n in ["sherpa_onnx", "parakeet_onnx", "nemotron_onnx"]}
    mod = _load_server_module()
    mod.MODEL_DIR = str(tmp_path / "models")
    os.makedirs(mod.MODEL_DIR, exist_ok=True)
    yield mod
    mod._parakeet_recognizer = None
    mod._nemotron_recognizer = None
    for name, value in saved.items():
        if value is not None:
            sys.modules[name] = value
        else:
            sys.modules.pop(name, None)


@pytest.fixture
def client(server, tmp_path):
    model_dir = tmp_path / "models"
    (model_dir / "ggml-base.en.bin").write_bytes(b"\x00" * 1024)
    server.model_path = str(model_dir / "ggml-base.en.bin")
    server.model_name = "base.en"
    server.model_loaded = True
    server.recording_process = None
    server.INSTALL_DIR = str(tmp_path)  # no whisper-server binary here
    server.app.config["TESTING"] = True
    return server.app.test_client()


def put_model(client, name):
    return client.put("/model", data=json.dumps({"model": name}), content_type="application/json")


class TestModelsEndpoint:
    def test_nemotron_listed_not_downloaded(self, server):
        server.app.config["TESTING"] = True
        models = server.app.test_client().get("/models").get_json()["models"]
        entry = {m["name"]: m for m in models}[server.NEMOTRON_MODEL_NAME]
        assert "nemotron" in entry["name"]
        assert entry["downloaded"] is False
        assert entry["active"] is False
        assert entry["size_mb"] == server.NEMOTRON_CATALOG_SIZE_MB
        assert entry["file"] == DIR_NAME

    def test_nemotron_listed_downloaded_and_active(self, server, tmp_path):
        write_nemotron_model(tmp_path / "models")
        server.active_engine = "nemotron"
        server.app.config["TESTING"] = True
        models = server.app.test_client().get("/models").get_json()["models"]
        entry = {m["name"]: m for m in models}[server.NEMOTRON_MODEL_NAME]
        assert entry["downloaded"] is True
        assert entry["active"] is True

    def test_parakeet_not_active_when_nemotron_is(self, server):
        server.active_engine = "nemotron"
        server.app.config["TESTING"] = True
        models = server.app.test_client().get("/models").get_json()["models"]
        entry = {m["name"]: m for m in models}[server.PARAKEET_MODEL_NAME]
        assert entry["active"] is False


class TestSwitchToNemotron:
    def test_missing_model_dir_names_update_model(self, server, client):
        resp = put_model(client, server.NEMOTRON_MODEL_NAME)
        assert resp.status_code == 404
        body = resp.get_json()
        assert body["error"] == "model_not_found"
        assert "update-model.sh nemotron" in body["message"]
        assert server.active_engine == "whisper"

    def test_no_backend(self, server, client, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = None  # import fails
        resp = put_model(client, server.NEMOTRON_MODEL_NAME)
        assert resp.status_code == 500
        assert resp.get_json()["error"] == "engine_unavailable"
        assert server.active_engine == "whisper"

    def test_switch_reports_nemotron_and_unloads_parakeet(self, server, client, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module()
        parakeet = object()
        server._parakeet_recognizer = parakeet
        server._parakeet_backend = "onnxruntime"

        resp = put_model(client, server.NEMOTRON_MODEL_NAME)
        assert resp.status_code == 200
        assert resp.get_json()["model"] == server.NEMOTRON_MODEL_NAME
        assert server.active_engine == "nemotron"
        assert server._parakeet_recognizer is None
        assert server._nemotron_recognizer is not None

        status = client.get("/status").get_json()
        assert status["engine"] == "nemotron"
        assert status["engine_backend"] == "onnxruntime"
        assert status["model"] == server.NEMOTRON_MODEL_NAME

    def test_recognizer_gets_the_model_dir_and_threads(self, server, client, tmp_path):
        base = write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module()
        put_model(client, server.NEMOTRON_MODEL_NAME)
        assert server._nemotron_recognizer.model_dir == str(base)
        assert server._nemotron_recognizer.num_threads == server.NEMOTRON_THREADS

    def test_failed_load_puts_parakeet_back(self, server, client, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = None  # import fails
        parakeet = object()
        server._parakeet_recognizer = parakeet
        restored = []
        server.load_parakeet = lambda: restored.append(True) or True

        resp = put_model(client, server.NEMOTRON_MODEL_NAME)
        assert resp.status_code == 500
        assert restored == [True]

    def test_switch_to_parakeet_unloads_nemotron(self, server, client, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module()
        put_model(client, server.NEMOTRON_MODEL_NAME)
        assert server._nemotron_recognizer is not None

        # Parakeet model + a fake sherpa backend
        pk = tmp_path / "models" / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
        pk.mkdir()
        for part in ["encoder", "decoder", "joiner"]:
            (pk / f"{part}.int8.onnx").write_bytes(b"\x00")
        (pk / "tokens.txt").write_text("<blk> 0\n")
        fake = types.ModuleType("sherpa_onnx")
        fake.OfflineRecognizer = types.SimpleNamespace(from_transducer=lambda **kw: object())
        sys.modules["sherpa_onnx"] = fake

        resp = put_model(client, server.PARAKEET_MODEL_NAME)
        assert resp.status_code == 200
        assert server.active_engine == "parakeet"
        assert server._nemotron_recognizer is None

    def test_switch_to_whisper_unloads_nemotron(self, server, client, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module()
        put_model(client, server.NEMOTRON_MODEL_NAME)

        resp = put_model(client, "base.en")
        assert resp.status_code == 200
        assert server.active_engine == "whisper"
        assert server._nemotron_recognizer is None


class TestRunTranscription:
    def test_nemotron_engine_used_when_active(self, server, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module(" Hello from Nemotron. ")
        assert server.load_nemotron() is True
        server.active_engine = "nemotron"
        server.word_corrections = {}

        wav = tmp_path / "t.wav"
        write_wav(wav)
        text, duration_ms = server.run_transcription(str(wav))
        assert text == "Hello from Nemotron."
        assert duration_ms >= 0

    def test_applies_corrections(self, server, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module(" ask quad about it ")
        server.load_nemotron()
        server.active_engine = "nemotron"
        server.word_corrections = {"quad": "Claude"}

        wav = tmp_path / "t.wav"
        write_wav(wav)
        text, _ = server.run_transcription(str(wav))
        assert text == "ask Claude about it"

    def test_falls_back_to_whisper_on_error(self, server, tmp_path):
        server.active_engine = "nemotron"

        class Broken:
            def transcribe(self, audio, sample_rate=16000):
                raise RuntimeError("boom")

        server._nemotron_recognizer = Broken()
        server.run_whisper = lambda wav_path, postprocess=True: ("from whisper", 42)
        wav = tmp_path / "t.wav"
        write_wav(wav)
        text, duration_ms = server.run_transcription(str(wav))
        assert text == "from whisper"
        assert duration_ms == 42


class TestLoadAndSelect:
    def test_load_without_model_dir(self, server):
        assert server.load_nemotron() is False

    def test_load_is_idempotent(self, server, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module()
        assert server.load_nemotron() is True
        first = server._nemotron_recognizer
        assert server.load_nemotron() is True
        assert server._nemotron_recognizer is first

    def test_load_error_returns_false(self, server, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module(load_error=RuntimeError("bad onnx"))
        assert server.load_nemotron() is False
        assert server._nemotron_recognizer is None

    def test_stt_engine_nemotron_at_start(self, server, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module()
        server.STT_ENGINE = "nemotron"
        server.select_engine()
        assert server.active_engine == "nemotron"
        assert server.model_loaded is True
        assert server.model_name == server.NEMOTRON_MODEL_NAME

    def test_stt_engine_nemotron_unavailable_falls_back(self, server):
        server.STT_ENGINE = "nemotron"
        server.model_name = "base.en"
        server.select_engine()
        assert server.active_engine == "whisper"

    def test_auto_never_picks_nemotron(self, server, tmp_path):
        write_nemotron_model(tmp_path / "models")
        sys.modules["nemotron_onnx"] = make_stub_module()
        server.STT_ENGINE = "auto"
        server.model_name = "base.en"
        server.select_engine()
        assert server.active_engine == "whisper"
        assert server._nemotron_recognizer is None


# ---------------------------------------------------------------------------
# The RNNT loop, against fake onnxruntime sessions (needs numpy)
# ---------------------------------------------------------------------------

BLANK = 3
VOCAB = ["<unk>", "▁hello", "▁wor", "<blk>"]  # ids 0..3, blank last


class _IO:
    def __init__(self, name):
        self.name = name


class FakeEncoder:
    """Records every feed; each cache comes back as the one it was given + 1."""

    def __init__(self, np, meta=None, frames_out=2):
        self.np = np
        self.meta = {
            "cache_last_channel_dim1": "2", "cache_last_channel_dim2": "3", "cache_last_channel_dim3": "4",
            "cache_last_time_dim1": "2", "cache_last_time_dim2": "4", "cache_last_time_dim3": "5",
        }
        self.meta.update(meta or {})
        self.frames_out = frames_out
        self.feeds = []

    def get_modelmeta(self):
        return types.SimpleNamespace(custom_metadata_map=self.meta)

    def get_inputs(self):
        return [_IO(n) for n in ["audio_signal", "length", "cache_last_channel", "cache_last_time", "cache_last_channel_len"]]

    def get_outputs(self):
        return [_IO(n) for n in ["outputs", "encoded_lengths", "cache_last_channel_next", "cache_last_time_next", "cache_last_channel_next_len"]]

    def run(self, output_names, feed):
        np = self.np
        self.feeds.append({k: np.array(v, copy=True) for k, v in feed.items()})
        out = np.zeros((1, 1024, self.frames_out), dtype=np.float32)
        # tag each output frame with a running index so the joiner can tell frames apart
        for i in range(self.frames_out):
            out[0, 0, i] = len(self.feeds) * 100 + i
        return [
            out,
            np.array([self.frames_out], dtype=np.int64),
            feed["cache_last_channel"] + 1,
            feed["cache_last_time"] + 1,
            feed["cache_last_channel_len"] + 1,
        ]


class FakeDecoder:
    """Decoder output encodes the token it was fed; states count the steps."""

    def __init__(self, np):
        self.np = np
        self.calls = []  # (token, state0 sum)

    def get_inputs(self):
        return [_IO(n) for n in ["targets", "target_length", "states.1", "onnx::Slice_3"]]

    def get_outputs(self):
        return [_IO(n) for n in ["outputs", "prednet_lengths", "states", "162"]]

    def run(self, output_names, feed):
        np = self.np
        token = int(feed["targets"].reshape(-1)[0])
        s0, s1 = feed["states.1"], feed["onnx::Slice_3"]
        self.calls.append((token, float(s0.sum())))
        out = np.full((1, 640, 1), float(token), dtype=np.float32)
        return [out, np.array([1], dtype=np.int32), s0 + 1, s1 + 1]


class FakeJoiner:
    """Picks the next symbol from a script keyed by (frame tag, last token)."""

    def __init__(self, np, script, default=BLANK):
        self.np = np
        self.script = list(script)  # consumed one entry per call
        self.default = default
        self.calls = []

    def get_inputs(self):
        return [_IO("encoder_outputs"), _IO("decoder_outputs")]

    def get_outputs(self):
        return [_IO("outputs")]

    def run(self, output_names, feed):
        np = self.np
        frame_tag = float(feed["encoder_outputs"].reshape(-1)[0])
        last_token = int(feed["decoder_outputs"].reshape(-1)[0])
        self.calls.append((frame_tag, last_token))
        pick = self.script.pop(0) if self.script else self.default
        logits = np.full((1, 1, 1, len(VOCAB)), -10.0, dtype=np.float32)
        logits[0, 0, 0, pick] = 5.0
        return [logits]


@pytest.fixture
def nemo(tmp_path, monkeypatch):
    """Import nemotron_onnx against a fake onnxruntime; return a builder."""
    np = pytest.importorskip("numpy")

    fake_ort = types.ModuleType("onnxruntime")

    class SessionOptions:
        pass

    fake_ort.SessionOptions = SessionOptions
    sessions = {}

    def inference_session(path, sess_options=None, providers=None):
        return sessions[os.path.basename(path).split(".")[0]]

    fake_ort.InferenceSession = inference_session
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)
    monkeypatch.delitem(sys.modules, "nemotron_onnx", raising=False)
    import nemotron_onnx

    model_dir = tmp_path / "nemo"
    model_dir.mkdir()
    (model_dir / "tokens.txt").write_text("".join(f"{t} {i}\n" for i, t in enumerate(VOCAB)), encoding="utf-8")
    for part in ["encoder", "decoder", "joiner"]:
        (model_dir / f"{part}.int8.onnx").write_bytes(b"\x00")

    def build(script, meta=None, frames_out=2):
        sessions["encoder"] = FakeEncoder(np, meta, frames_out)
        sessions["decoder"] = FakeDecoder(np)
        sessions["joiner"] = FakeJoiner(np, script)
        rec = nemotron_onnx.NemotronRecognizer(str(model_dir), num_threads=1)
        return types.SimpleNamespace(
            np=np, mod=nemotron_onnx, rec=rec,
            enc=sessions["encoder"], dec=sessions["decoder"], joi=sessions["joiner"],
        )

    yield build
    sys.modules.pop("nemotron_onnx", None)


def _tone(np, seconds):
    t = np.arange(int(16000 * seconds)) / 16000.0
    return (0.3 * np.sin(2 * np.pi * 300.0 * t)).astype(np.float32)


def _n_chunks(h, audio, shift=16):
    padded = np_concat_tail(h, audio)
    frames = h.mod.compute_fbank(padded).shape[0]
    return math.ceil(frames / shift)


def np_concat_tail(h, audio):
    return h.np.concatenate([audio, h.np.zeros(int(h.mod.SAMPLE_RATE * h.mod.TAIL_PADDING_SECONDS), dtype=h.np.float32)])


class TestRnntGreedyLoop:
    def test_emits_scripted_tokens_and_skips_blanks(self, nemo):
        # frame 1: "▁hello" then blank; frame 2: blank; frame 3: "wor" then blank
        h = nemo([1, BLANK, BLANK, 2, BLANK], frames_out=2)
        text = h.rec.transcribe(_tone(h.np, 0.5))
        assert text == "hello wor"

    def test_sentencepiece_marks_become_spaces_and_text_is_trimmed(self, nemo):
        h = nemo([1, 1, BLANK, 2, BLANK])
        assert h.rec.transcribe(_tone(h.np, 0.5)) == "hello hello wor"

    def test_all_blank_is_empty(self, nemo):
        h = nemo([])
        assert h.rec.transcribe(_tone(h.np, 0.5)) == ""

    def test_decoder_runs_on_each_emitted_token_with_state_carried(self, nemo):
        h = nemo([1, 2, BLANK])
        h.rec.transcribe(_tone(h.np, 0.5))
        tokens = [t for t, _ in h.dec.calls]
        # start with blank, then once per emitted token, in order
        assert tokens[:3] == [BLANK, 1, 2]
        # the LSTM state is carried: each call sees the state the last emit produced
        assert [s for _, s in h.dec.calls][1] > [s for _, s in h.dec.calls][0]
        assert [s for _, s in h.dec.calls][2] > [s for _, s in h.dec.calls][1]

    def test_joiner_sees_the_latest_token_after_an_emit(self, nemo):
        h = nemo([1, 2, BLANK])
        h.rec.transcribe(_tone(h.np, 0.5))
        assert [last for _, last in h.joi.calls[:3]] == [BLANK, 1, 2]

    def test_blank_advances_to_the_next_encoder_frame(self, nemo):
        h = nemo([BLANK, BLANK, BLANK, BLANK])
        h.rec.transcribe(_tone(h.np, 0.5))
        tags = [tag for tag, _ in h.joi.calls[:4]]
        assert tags == [100.0, 101.0, 200.0, 201.0]

    def test_symbols_per_frame_are_capped(self, nemo):
        # a joiner that never says blank must not loop forever
        h = nemo([1] * 10000)
        h.rec.transcribe(_tone(h.np, 0.5))
        n_frames = len(h.enc.feeds) * 2
        cap = h.mod.MAX_SYMBOLS_PER_FRAME
        assert len(h.joi.calls) == n_frames * cap

    def test_cap_moves_on_to_the_next_frame(self, nemo):
        h = nemo([1] * 10000)
        h.rec.transcribe(_tone(h.np, 0.5))
        tags = [tag for tag, _ in h.joi.calls]
        assert tags[0] == 100.0 and tags[h.mod.MAX_SYMBOLS_PER_FRAME] == 101.0


class TestStreamingEncoderChunks:
    def test_caches_start_at_zero_and_are_carried(self, nemo):
        h = nemo([])
        h.rec.transcribe(_tone(h.np, 1.0))
        feeds = h.enc.feeds
        assert len(feeds) >= 3
        np = h.np
        assert feeds[0]["cache_last_channel"].shape == (1, 2, 3, 4)
        assert feeds[0]["cache_last_time"].shape == (1, 2, 4, 5)
        assert not feeds[0]["cache_last_channel"].any()
        assert not feeds[0]["cache_last_time"].any()
        assert int(feeds[0]["cache_last_channel_len"][0]) == 0
        # the fake adds 1 to every cache it is given; chunk i must see i
        for i, feed in enumerate(feeds):
            assert np.all(feed["cache_last_channel"] == i)
            assert np.all(feed["cache_last_time"] == i)
            assert int(feed["cache_last_channel_len"][0]) == i

    def test_default_window_and_shift_are_25_and_16(self, nemo):
        h = nemo([])
        audio = _tone(h.np, 1.0)
        h.rec.transcribe(audio)
        assert h.rec.window == 25 and h.rec.shift == 16
        assert all(f["audio_signal"].shape == (1, 128, 25) for f in h.enc.feeds)
        assert all(int(f["length"][0]) == 25 for f in h.enc.feeds)
        assert len(h.enc.feeds) == _n_chunks(h, audio, 16)

    def test_window_and_shift_come_from_model_metadata(self, nemo):
        h = nemo([], meta={"window_size": "33", "chunk_shift": "24"})
        audio = _tone(h.np, 1.0)
        h.rec.transcribe(audio)
        assert h.rec.window == 33 and h.rec.shift == 24
        assert all(f["audio_signal"].shape == (1, 128, 33) for f in h.enc.feeds)
        assert len(h.enc.feeds) == _n_chunks(h, audio, 24)

    def test_chunks_advance_by_shift_over_the_same_features(self, nemo):
        h = nemo([])
        audio = _tone(h.np, 1.0)
        h.rec.transcribe(audio)
        feats = h.mod.compute_fbank(np_concat_tail(h, audio)).T
        for i, feed in enumerate(h.enc.feeds[:4]):
            expect = feats[:, 16 * i:16 * i + 25]
            assert h.np.allclose(feed["audio_signal"][0], expect)

    def test_last_chunk_is_zero_padded_to_the_window(self, nemo):
        h = nemo([])
        audio = _tone(h.np, 1.0)
        h.rec.transcribe(audio)
        feats = h.mod.compute_fbank(np_concat_tail(h, audio)).T
        total = feats.shape[1]
        last = h.enc.feeds[-1]["audio_signal"][0]
        start = 16 * (len(h.enc.feeds) - 1)
        real = total - start
        assert 0 < real <= 25
        assert h.np.allclose(last[:, :real], feats[:, start:])
        assert not last[:, real:].any()

    def test_a_second_utterance_starts_from_fresh_caches(self, nemo):
        h = nemo([])
        h.rec.transcribe(_tone(h.np, 0.5))
        n = len(h.enc.feeds)
        h.rec.transcribe(_tone(h.np, 0.5))
        second_first = h.enc.feeds[n]
        assert not second_first["cache_last_channel"].any()
        assert int(second_first["cache_last_channel_len"][0]) == 0

    def test_audio_too_short_for_a_frame_is_empty_text(self, nemo):
        h = nemo([1])
        h.mod.TAIL_PADDING_SECONDS = 0
        assert h.rec.transcribe(h.np.zeros(100, dtype=h.np.float32)) == ""
        assert h.enc.feeds == []

    def test_rejects_other_sample_rates(self, nemo):
        h = nemo([])
        with pytest.raises(RuntimeError, match="16000"):
            h.rec.transcribe(_tone(h.np, 0.5), sample_rate=8000)


# ---------------------------------------------------------------------------
# Real model (opt-in)
# ---------------------------------------------------------------------------

def _read_wav(np, path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return data.astype(np.float32) / 32768.0


def _norm(s):
    return " ".join("".join(c for c in s.lower() if c.isalnum() or c.isspace()).split())


@pytest.mark.skipif(not os.environ.get("NEMOTRON_MODEL_DIR"), reason="NEMOTRON_MODEL_DIR not set")
@pytest.mark.parametrize("wav_name", ["0.wav", "1.wav"])
def test_real_model_decodes_test_wav(wav_name):
    np = pytest.importorskip("numpy")
    pytest.importorskip("onnxruntime")
    model_dir = os.environ["NEMOTRON_MODEL_DIR"]
    sys.modules.pop("nemotron_onnx", None)
    import nemotron_onnx

    wavs = os.path.join(model_dir, "test_wavs")
    expected = {}
    with open(os.path.join(wavs, "trans.txt"), encoding="utf-8") as f:
        for line in f:
            name, _, text = line.strip().partition(" ")
            expected[name] = text

    rec = nemotron_onnx.NemotronRecognizer(model_dir, num_threads=4)
    text = rec.transcribe(_read_wav(np, os.path.join(wavs, wav_name)))
    print(f"{wav_name}: {text!r}")
    assert _norm(text) == _norm(expected[wav_name])
