"""Tests for the model benchmark endpoint."""

import importlib.util
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _load_server_module():
    """Import whisper-server.py as a module."""
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def server():
    return _load_server_module()


class TestBenchmarkEndpoint:
    """Test the POST /models/benchmark endpoint."""

    @pytest.fixture
    def client(self, server, tmp_path):
        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "ggml-base.en.bin").write_bytes(b"\x00" * 1024)
        (model_dir / "ggml-small.en.bin").write_bytes(b"\x00" * 2048)

        server.MODEL_DIR = str(model_dir)
        server.model_path = str(model_dir / "ggml-base.en.bin")
        server.model_name = "base.en"
        server.model_loaded = True
        server.model_size_mb = 0
        server.recording_process = None
        server.benchmark_running = False
        server.app.config["TESTING"] = True
        return server, server.app.test_client()

    def test_rejects_when_model_not_loaded(self, server, tmp_path):
        server.model_loaded = False
        server.recording_process = None
        server.benchmark_running = False
        server.app.config["TESTING"] = True
        client = server.app.test_client()
        resp = client.post(
            "/models/benchmark",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert resp.status_code == 503

    def test_rejects_during_recording(self, client):
        server, c = client
        server.recording_process = "fake"
        resp = c.post(
            "/models/benchmark",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert resp.status_code == 409
        assert resp.get_json()["error"] == "recording_active"
        server.recording_process = None

    def test_rejects_duplicate_benchmark(self, client):
        server, c = client
        server.benchmark_running = True
        resp = c.post(
            "/models/benchmark",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert resp.status_code == 409
        assert resp.get_json()["error"] == "benchmark_running"
        server.benchmark_running = False

    def test_rejects_no_matching_models(self, client):
        server, c = client
        resp = c.post(
            "/models/benchmark",
            data=json.dumps({"models": ["nonexistent"]}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert resp.get_json()["error"] == "no_matching_models"

    def test_rejects_when_no_models_downloaded(self, server, tmp_path):
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()
        server.MODEL_DIR = str(empty_dir)
        server.model_loaded = True
        server.recording_process = None
        server.benchmark_running = False
        server.app.config["TESTING"] = True
        c = server.app.test_client()
        resp = c.post(
            "/models/benchmark",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert resp.get_json()["error"] == "no_models"


class TestBenchmarkHelpers:
    """Test benchmark-related helper functions."""

    def test_list_models_includes_new_catalog_entries(self, server, tmp_path):
        """Verify new turbo models appear in the catalog."""
        model_dir = tmp_path / "models"
        model_dir.mkdir()
        server.MODEL_DIR = str(model_dir)
        server.model_path = ""
        server.model_loaded = False

        models = server.list_models()
        names = [m["name"] for m in models]
        assert "large-v3-turbo" in names
        assert "large-v3-turbo-q5_0" in names
        assert "large-v3-turbo-q8_0" in names

    def test_catalog_descriptions(self, server, tmp_path):
        model_dir = tmp_path / "models"
        model_dir.mkdir()
        server.MODEL_DIR = str(model_dir)
        server.model_path = ""

        models = server.list_models()
        by_name = {m["name"]: m for m in models}
        assert "faster" in by_name["large-v3-turbo"]["description"].lower()
        assert "quantized" in by_name["large-v3-turbo-q5_0"]["description"].lower()

    def test_turbo_models_detected_on_disk(self, server, tmp_path):
        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "ggml-large-v3-turbo-q5_0.bin").write_bytes(b"\x00" * 4096)

        server.MODEL_DIR = str(model_dir)
        server.model_path = str(model_dir / "ggml-large-v3-turbo-q5_0.bin")

        models = server.list_models()
        by_name = {m["name"]: m for m in models}
        assert by_name["large-v3-turbo-q5_0"]["downloaded"] is True
        assert by_name["large-v3-turbo-q5_0"]["active"] is True

    def test_vad_detection_no_model(self, server, tmp_path):
        """VAD should be unavailable when model file is missing."""
        server.VAD_MODEL_DIR = str(tmp_path / "nonexistent")
        server._vad_available = None  # reset cached value
        assert server._detect_vad_support() is False


class TestRunWhisperOnModel:
    """Test the run_whisper_on_model function."""

    def test_raises_without_binary(self, server, tmp_path):
        server.WHISPER_BIN = ""
        server.INSTALL_DIR = str(tmp_path)
        with pytest.raises(RuntimeError, match="binary not found"):
            server.run_whisper_on_model(
                str(tmp_path / "model.bin"),
                str(tmp_path / "audio.wav"),
            )
