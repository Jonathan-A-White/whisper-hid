"""Tests for the model management endpoints."""

import importlib.util
import json
import os
import sys
import tempfile

import pytest

# Add scripts directory to path
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
    """Load the whisper server module."""
    return _load_server_module()


class TestListModels:
    """Test the GET /models endpoint."""

    @pytest.fixture
    def client(self, server, tmp_path):
        # Create a fake models directory with some model files
        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "ggml-base.en.bin").write_bytes(b"\x00" * 1024)
        (model_dir / "ggml-small.en.bin").write_bytes(b"\x00" * 2048)
        (model_dir / "ggml-tiny.en.bin").write_bytes(b"\x00" * 512)
        # Non-model files should be ignored
        (model_dir / "README.txt").write_text("not a model")
        (model_dir / "other.bin").write_bytes(b"\x00" * 100)

        server.MODEL_DIR = str(model_dir)
        server.model_path = str(model_dir / "ggml-base.en.bin")
        server.model_name = "base.en"
        server.model_loaded = True
        server.app.config["TESTING"] = True
        return server.app.test_client()

    def test_list_models(self, client):
        resp = client.get("/models")
        assert resp.status_code == 200
        data = resp.get_json()
        assert "models" in data
        models = data["models"]
        assert len(models) == 3

        names = [m["name"] for m in models]
        assert "base.en" in names
        assert "small.en" in names
        assert "tiny.en" in names

    def test_active_flag(self, client):
        resp = client.get("/models")
        models = resp.get_json()["models"]
        active = [m for m in models if m["active"]]
        assert len(active) == 1
        assert active[0]["name"] == "base.en"

    def test_model_info_fields(self, client):
        resp = client.get("/models")
        models = resp.get_json()["models"]
        for m in models:
            assert "name" in m
            assert "file" in m
            assert "size_mb" in m
            assert "active" in m
            assert m["file"].startswith("ggml-")
            assert m["file"].endswith(".bin")

    def test_empty_model_dir(self, server, tmp_path):
        empty_dir = tmp_path / "empty_models"
        empty_dir.mkdir()
        server.MODEL_DIR = str(empty_dir)
        server.app.config["TESTING"] = True
        client = server.app.test_client()
        resp = client.get("/models")
        assert resp.status_code == 200
        assert resp.get_json()["models"] == []

    def test_missing_model_dir(self, server, tmp_path):
        server.MODEL_DIR = str(tmp_path / "nonexistent")
        server.app.config["TESTING"] = True
        client = server.app.test_client()
        resp = client.get("/models")
        assert resp.status_code == 200
        assert resp.get_json()["models"] == []


class TestSwitchModel:
    """Test the PUT /model endpoint."""

    @pytest.fixture
    def setup(self, server, tmp_path):
        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "ggml-base.en.bin").write_bytes(b"\x00" * 1024)
        (model_dir / "ggml-small.en.bin").write_bytes(b"\x00" * 2048)

        server.MODEL_DIR = str(model_dir)
        server.model_path = str(model_dir / "ggml-base.en.bin")
        server.model_name = "base.en"
        server.model_size_mb = 0
        server.model_loaded = True
        server.recording_process = None
        server.app.config["TESTING"] = True
        return server, server.app.test_client()

    def test_switch_model(self, setup):
        server, client = setup
        resp = client.put(
            "/model",
            data=json.dumps({"model": "small.en"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["model"] == "small.en"
        assert server.model_name == "small.en"
        assert server.model_loaded is True

    def test_switch_to_nonexistent_model(self, setup):
        server, client = setup
        resp = client.put(
            "/model",
            data=json.dumps({"model": "large-v3"}),
            content_type="application/json",
        )
        assert resp.status_code == 404
        assert resp.get_json()["error"] == "model_not_found"
        # Original model should be unchanged
        assert server.model_name == "base.en"

    def test_switch_missing_body(self, setup):
        _, client = setup
        resp = client.put(
            "/model",
            data="not json",
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_switch_empty_model_name(self, setup):
        _, client = setup
        resp = client.put(
            "/model",
            data=json.dumps({"model": ""}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_switch_no_model_field(self, setup):
        _, client = setup
        resp = client.put(
            "/model",
            data=json.dumps({"wrong_field": "base.en"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_switch_while_recording(self, setup):
        server, client = setup
        server.recording_process = "fake"  # simulate active recording
        resp = client.put(
            "/model",
            data=json.dumps({"model": "small.en"}),
            content_type="application/json",
        )
        assert resp.status_code == 409
        assert resp.get_json()["error"] == "recording_active"
        server.recording_process = None

    def test_switch_updates_active_in_models_list(self, setup):
        server, client = setup
        # Switch to small.en
        client.put(
            "/model",
            data=json.dumps({"model": "small.en"}),
            content_type="application/json",
        )
        # Check /models reflects the change
        resp = client.get("/models")
        models = resp.get_json()["models"]
        active = [m for m in models if m["active"]]
        assert len(active) == 1
        assert active[0]["name"] == "small.en"
