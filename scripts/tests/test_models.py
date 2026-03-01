"""Tests for the model management endpoints."""

import importlib.util
import json
import os
import sys

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

    def test_includes_catalog_and_downloaded(self, client, server):
        resp = client.get("/models")
        assert resp.status_code == 200
        models = resp.get_json()["models"]
        names = [m["name"] for m in models]
        # All catalog entries should appear
        for entry in server.MODEL_CATALOG:
            assert entry["name"] in names
        # Downloaded models should appear too
        assert "base.en" in names
        assert "small.en" in names
        assert "tiny.en" in names

    def test_downloaded_flag(self, client):
        resp = client.get("/models")
        models = resp.get_json()["models"]
        by_name = {m["name"]: m for m in models}
        assert by_name["base.en"]["downloaded"] is True
        assert by_name["small.en"]["downloaded"] is True
        assert by_name["tiny.en"]["downloaded"] is True
        # medium.en is in catalog but not on disk
        assert by_name["medium.en"]["downloaded"] is False

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
            assert "description" in m
            assert "downloaded" in m
            assert "active" in m
            assert m["file"].startswith("ggml-")
            assert m["file"].endswith(".bin")

    def test_description_from_catalog(self, client, server):
        resp = client.get("/models")
        models = resp.get_json()["models"]
        by_name = {m["name"]: m for m in models}
        for entry in server.MODEL_CATALOG:
            assert by_name[entry["name"]]["description"] == entry["description"]

    def test_not_downloaded_uses_catalog_size(self, client, server):
        resp = client.get("/models")
        models = resp.get_json()["models"]
        by_name = {m["name"]: m for m in models}
        # medium.en is not downloaded — should use catalog size
        catalog_medium = next(e for e in server.MODEL_CATALOG if e["name"] == "medium.en")
        assert by_name["medium.en"]["size_mb"] == catalog_medium["size_mb"]

    def test_custom_model_not_in_catalog(self, server, tmp_path):
        """Models on disk that aren't in the catalog should still appear."""
        model_dir = tmp_path / "models2"
        model_dir.mkdir()
        (model_dir / "ggml-custom-finetune.bin").write_bytes(b"\x00" * 4096)

        server.MODEL_DIR = str(model_dir)
        server.model_path = ""
        server.app.config["TESTING"] = True
        client = server.app.test_client()

        resp = client.get("/models")
        models = resp.get_json()["models"]
        by_name = {m["name"]: m for m in models}
        assert "custom-finetune" in by_name
        assert by_name["custom-finetune"]["downloaded"] is True
        assert by_name["custom-finetune"]["description"] == ""

    def test_empty_model_dir_returns_catalog(self, server, tmp_path):
        empty_dir = tmp_path / "empty_models"
        empty_dir.mkdir()
        server.MODEL_DIR = str(empty_dir)
        server.app.config["TESTING"] = True
        client = server.app.test_client()
        resp = client.get("/models")
        models = resp.get_json()["models"]
        # Should still return catalog entries (all not downloaded)
        assert len(models) == len(server.MODEL_CATALOG)
        assert all(m["downloaded"] is False for m in models)

    def test_missing_model_dir_returns_catalog(self, server, tmp_path):
        server.MODEL_DIR = str(tmp_path / "nonexistent")
        server.app.config["TESTING"] = True
        client = server.app.test_client()
        resp = client.get("/models")
        models = resp.get_json()["models"]
        assert len(models) == len(server.MODEL_CATALOG)
        assert all(m["downloaded"] is False for m in models)


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
        server.recording_process = "fake"
        resp = client.put(
            "/model",
            data=json.dumps({"model": "small.en"}),
            content_type="application/json",
        )
        assert resp.status_code == 409
        assert resp.get_json()["error"] == "recording_active"
        server.recording_process = None

    def test_switch_updates_active_in_models_list(self, setup):
        _, client = setup
        client.put(
            "/model",
            data=json.dumps({"model": "small.en"}),
            content_type="application/json",
        )
        resp = client.get("/models")
        models = resp.get_json()["models"]
        active = [m for m in models if m["active"]]
        assert len(active) == 1
        assert active[0]["name"] == "small.en"
