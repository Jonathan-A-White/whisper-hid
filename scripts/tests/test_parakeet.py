"""Tests for the Parakeet engine (sherpa-onnx integration)."""

import importlib.util
import json
import os
import struct
import sys
import types
import wave

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _load_server_module():
    """Import whisper-server.py as a module."""
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeStream:
    def __init__(self, text):
        self.result = types.SimpleNamespace(text=text)
        self.accepted = []

    def accept_waveform(self, sample_rate, samples):
        self.accepted.append((sample_rate, len(samples)))


class FakeRecognizer:
    def __init__(self, text):
        self._text = text
        self.decoded = 0

    def create_stream(self):
        return FakeStream(self._text)

    def decode_stream(self, stream):
        self.decoded += 1


def make_fake_sherpa(text=" hello world ", load_error=None):
    """Build a fake sherpa_onnx module returning a FakeRecognizer."""
    mod = types.ModuleType("sherpa_onnx")
    captured = {}

    def from_transducer(**kwargs):
        if load_error is not None:
            raise load_error
        captured.update(kwargs)
        return FakeRecognizer(text)

    mod.OfflineRecognizer = types.SimpleNamespace(from_transducer=from_transducer)
    mod._captured = captured
    return mod


def write_parakeet_model(model_dir, int8=True):
    """Create fake Parakeet model files on disk."""
    base = model_dir / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
    base.mkdir(parents=True)
    suffix = ".int8.onnx" if int8 else ".onnx"
    for part in ["encoder", "decoder", "joiner"]:
        (base / f"{part}{suffix}").write_bytes(b"\x00" * 1024)
    (base / "tokens.txt").write_text("<blk> 0\n")
    return base


def write_wav(path, num_samples=1600, sample_rate=16000, value=1000):
    """Write a small valid 16-bit mono PCM WAV."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(struct.pack(f"<{num_samples}h", *([value] * num_samples)))


@pytest.fixture
def server(tmp_path):
    """Fresh server module with MODEL_DIR pointed at a temp dir."""
    saved = sys.modules.pop("sherpa_onnx", None)
    mod = _load_server_module()
    mod.MODEL_DIR = str(tmp_path / "models")
    os.makedirs(mod.MODEL_DIR, exist_ok=True)
    yield mod
    mod._parakeet_recognizer = None
    if saved is not None:
        sys.modules["sherpa_onnx"] = saved
    else:
        sys.modules.pop("sherpa_onnx", None)


class TestFindParakeetModelFiles:
    def test_missing_dir(self, server):
        assert server.find_parakeet_model_files() is None

    def test_finds_int8_files(self, server, tmp_path):
        base = write_parakeet_model(tmp_path / "models")
        files = server.find_parakeet_model_files()
        assert files is not None
        assert files["encoder"] == str(base / "encoder.int8.onnx")
        assert files["tokens"] == str(base / "tokens.txt")

    def test_falls_back_to_fp32_files(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models", int8=False)
        files = server.find_parakeet_model_files()
        assert files is not None
        assert files["encoder"].endswith("encoder.onnx")

    def test_incomplete_dir(self, server, tmp_path):
        base = write_parakeet_model(tmp_path / "models")
        os.unlink(base / "tokens.txt")
        assert server.find_parakeet_model_files() is None


class TestLoadParakeet:
    def test_no_model_files(self, server):
        sys.modules["sherpa_onnx"] = make_fake_sherpa()
        assert server.load_parakeet() is False

    def test_sherpa_not_installed(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = None  # makes "import sherpa_onnx" fail
        assert server.load_parakeet() is False

    def test_loads_with_fake_sherpa(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        fake = make_fake_sherpa()
        sys.modules["sherpa_onnx"] = fake
        assert server.load_parakeet() is True
        assert server._parakeet_recognizer is not None
        assert fake._captured["model_type"] == "nemo_transducer"
        assert fake._captured["encoder"].endswith("encoder.int8.onnx")

    def test_load_is_idempotent(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa()
        assert server.load_parakeet() is True
        first = server._parakeet_recognizer
        assert server.load_parakeet() is True
        assert server._parakeet_recognizer is first

    def test_load_error_returns_false(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa(load_error=RuntimeError("bad model"))
        assert server.load_parakeet() is False
        assert server._parakeet_recognizer is None

    def test_unload(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa()
        server.load_parakeet()
        server.unload_parakeet()
        assert server._parakeet_recognizer is None


class TestReadWavFloat32:
    def test_reads_mono_16bit(self, server, tmp_path):
        wav = tmp_path / "test.wav"
        write_wav(wav, num_samples=160, value=16384)
        audio, sample_rate = server._read_wav_float32(str(wav))
        assert sample_rate == 16000
        assert len(audio) == 160
        assert abs(audio[0] - 0.5) < 0.001

    def test_rejects_8bit(self, server, tmp_path):
        wav = tmp_path / "test8.wav"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(1)
            w.setframerate(16000)
            w.writeframes(b"\x80" * 100)
        with pytest.raises(RuntimeError, match="sample width"):
            server._read_wav_float32(str(wav))


class TestRunTranscription:
    def test_parakeet_engine_used_when_active(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa(" Hello from Parakeet. ")
        assert server.load_parakeet() is True
        server.active_engine = "parakeet"
        server.word_corrections = {}

        wav = tmp_path / "test.wav"
        write_wav(wav)
        text, duration_ms = server.run_transcription(str(wav))
        assert text == "Hello from Parakeet."
        assert duration_ms >= 0

    def test_applies_corrections(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa(" ask quad about it ")
        server.load_parakeet()
        server.active_engine = "parakeet"
        server.word_corrections = {"quad": "Claude"}

        wav = tmp_path / "test.wav"
        write_wav(wav)
        text, _ = server.run_transcription(str(wav))
        assert text == "ask Claude about it"

    def test_filters_silence_markers(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa("[BLANK_AUDIO]")
        server.load_parakeet()
        server.active_engine = "parakeet"
        server.word_corrections = {}

        wav = tmp_path / "test.wav"
        write_wav(wav)
        text, _ = server.run_transcription(str(wav))
        assert text == ""

    def test_falls_back_to_whisper_on_error(self, server, tmp_path):
        server.active_engine = "parakeet"

        class BrokenRecognizer:
            def create_stream(self):
                raise RuntimeError("boom")

        server._parakeet_recognizer = BrokenRecognizer()
        server.run_whisper = lambda wav_path: ("from whisper", 42)

        wav = tmp_path / "test.wav"
        write_wav(wav)
        text, duration_ms = server.run_transcription(str(wav))
        assert text == "from whisper"
        assert duration_ms == 42

    def test_whisper_used_when_engine_whisper(self, server, tmp_path):
        server.active_engine = "whisper"
        server.run_whisper = lambda wav_path: ("whisper text", 10)
        text, _ = server.run_transcription(str(tmp_path / "missing.wav"))
        assert text == "whisper text"


class TestModelsEndpoint:
    def test_parakeet_listed_not_downloaded(self, server):
        server.app.config["TESTING"] = True
        client = server.app.test_client()
        models = client.get("/models").get_json()["models"]
        by_name = {m["name"]: m for m in models}
        entry = by_name[server.PARAKEET_MODEL_NAME]
        assert entry["downloaded"] is False
        assert entry["active"] is False
        assert entry["size_mb"] == server.PARAKEET_CATALOG_SIZE_MB

    def test_parakeet_listed_downloaded_and_active(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        server.active_engine = "parakeet"
        server.app.config["TESTING"] = True
        client = server.app.test_client()
        models = client.get("/models").get_json()["models"]
        by_name = {m["name"]: m for m in models}
        entry = by_name[server.PARAKEET_MODEL_NAME]
        assert entry["downloaded"] is True
        assert entry["active"] is True


class TestSwitchEngine:
    @pytest.fixture
    def client(self, server, tmp_path):
        model_dir = tmp_path / "models"
        (model_dir / "ggml-base.en.bin").write_bytes(b"\x00" * 1024)
        server.model_path = str(model_dir / "ggml-base.en.bin")
        server.model_name = "base.en"
        server.model_loaded = True
        server.recording_process = None
        server.INSTALL_DIR = str(tmp_path)  # no whisper-server binary here
        server.app.config["TESTING"] = True
        return server.app.test_client()

    def test_switch_to_parakeet(self, server, client, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa()

        resp = client.put(
            "/model",
            data=json.dumps({"model": server.PARAKEET_MODEL_NAME}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["ok"] is True
        assert server.active_engine == "parakeet"
        assert server.model_name == server.PARAKEET_MODEL_NAME

        status = client.get("/status").get_json()
        assert status["engine"] == "parakeet"
        assert status["model"] == server.PARAKEET_MODEL_NAME

    def test_switch_to_parakeet_not_downloaded(self, server, client):
        resp = client.put(
            "/model",
            data=json.dumps({"model": server.PARAKEET_MODEL_NAME}),
            content_type="application/json",
        )
        assert resp.status_code == 404
        assert resp.get_json()["error"] == "model_not_found"
        assert server.active_engine == "whisper"

    def test_switch_to_parakeet_sherpa_missing(self, server, client, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = None  # import fails

        resp = client.put(
            "/model",
            data=json.dumps({"model": server.PARAKEET_MODEL_NAME}),
            content_type="application/json",
        )
        assert resp.status_code == 500
        assert resp.get_json()["error"] == "engine_unavailable"
        assert server.active_engine == "whisper"

    def test_switch_back_to_whisper_unloads_parakeet(self, server, client, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa()
        client.put(
            "/model",
            data=json.dumps({"model": server.PARAKEET_MODEL_NAME}),
            content_type="application/json",
        )
        assert server.active_engine == "parakeet"

        resp = client.put(
            "/model",
            data=json.dumps({"model": "base.en"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert server.active_engine == "whisper"
        assert server.model_name == "base.en"
        assert server._parakeet_recognizer is None


class TestSelectEngine:
    def test_prefers_parakeet_when_available(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa()
        server.STT_ENGINE = "auto"
        server.select_engine()
        assert server.active_engine == "parakeet"
        assert server.model_loaded is True
        assert server.model_name == server.PARAKEET_MODEL_NAME

    def test_whisper_when_parakeet_unavailable(self, server):
        server.STT_ENGINE = "auto"
        server.model_name = "base.en"
        server.select_engine()
        assert server.active_engine == "whisper"

    def test_forced_whisper(self, server, tmp_path):
        write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = make_fake_sherpa()
        server.STT_ENGINE = "whisper"
        server.select_engine()
        assert server.active_engine == "whisper"
        assert server._parakeet_recognizer is None
