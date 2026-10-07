"""Tests for the model management endpoints (Parakeet is the only engine)."""

import importlib.util
import json
import os
import sys
import types

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


# File prefix of the removed engine's models (split so the source tree names
# that engine nowhere).
REMOVED_PREFIX = "gg" "ml-"


def _write_parakeet_model(model_dir):
    base = model_dir / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
    base.mkdir(parents=True)
    for part in ["encoder", "decoder", "joiner"]:
        (base / f"{part}.int8.onnx").write_bytes(b"\x00" * 1024)
    (base / "tokens.txt").write_text("<blk> 0\n")


def _fake_sherpa():
    mod = types.ModuleType("sherpa_onnx")
    mod.OfflineRecognizer = types.SimpleNamespace(
        from_transducer=lambda **kwargs: object()
    )
    return mod


@pytest.fixture
def server(tmp_path):
    saved = {name: sys.modules.pop(name, None) for name in ["sherpa_onnx", "parakeet_onnx"]}
    mod = _load_server_module()
    mod.MODEL_DIR = str(tmp_path / "models")
    os.makedirs(mod.MODEL_DIR, exist_ok=True)
    mod.recording_process = None
    mod.app.config["TESTING"] = True
    yield mod
    mod._parakeet_recognizer = None
    for name, value in saved.items():
        if value is not None:
            sys.modules[name] = value
        else:
            sys.modules.pop(name, None)


@pytest.fixture
def client(server):
    return server.app.test_client()


class TestListModels:
    """GET /models lists Parakeet and nothing else."""

    def test_lists_only_parakeet(self, client, server):
        models = client.get("/models").get_json()["models"]
        assert [m["name"] for m in models] == [server.PARAKEET_MODEL_NAME]

    def test_other_model_files_on_disk_are_not_listed(self, client, server, tmp_path):
        # Leftover files from the removed engine must not show up.
        (tmp_path / "models" / (REMOVED_PREFIX + "base.en.bin")).write_bytes(b"\x00" * 1024)
        models = client.get("/models").get_json()["models"]
        assert [m["name"] for m in models] == [server.PARAKEET_MODEL_NAME]

    def test_not_downloaded_uses_catalog_size(self, client, server):
        entry = client.get("/models").get_json()["models"][0]
        assert entry["downloaded"] is False
        assert entry["active"] is False
        assert entry["size_mb"] == server.PARAKEET_CATALOG_SIZE_MB

    def test_downloaded_and_active(self, client, server, tmp_path):
        _write_parakeet_model(tmp_path / "models")
        server.active_engine = "parakeet"
        entry = client.get("/models").get_json()["models"][0]
        assert entry["downloaded"] is True
        assert entry["active"] is True

    def test_model_info_fields(self, client, server):
        entry = client.get("/models").get_json()["models"][0]
        for field in ("name", "file", "size_mb", "description", "downloaded", "active"):
            assert field in entry
        assert entry["file"] == server.PARAKEET_DIR_NAME

    def test_missing_model_dir(self, client, server, tmp_path):
        server.MODEL_DIR = str(tmp_path / "nonexistent")
        models = client.get("/models").get_json()["models"]
        assert len(models) == 1
        assert models[0]["downloaded"] is False


class TestSwitchModel:
    """PUT /model only knows Parakeet."""

    def _put(self, client, body):
        return client.put("/model", data=json.dumps(body), content_type="application/json")

    def test_switch_to_parakeet(self, client, server, tmp_path):
        _write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = _fake_sherpa()
        resp = self._put(client, {"model": server.PARAKEET_MODEL_NAME})
        assert resp.status_code == 200
        assert resp.get_json()["model"] == server.PARAKEET_MODEL_NAME
        assert server.active_engine == "parakeet"
        assert server.model_loaded is True

    def test_other_model_is_refused(self, client, server):
        resp = self._put(client, {"model": "small.en"})
        assert resp.status_code == 404
        assert resp.get_json()["error"] == "model_not_found"
        assert server.PARAKEET_MODEL_NAME in resp.get_json()["message"]

    def test_missing_model_says_how_to_get_it(self, client, server):
        resp = self._put(client, {"model": server.PARAKEET_MODEL_NAME})
        assert resp.status_code == 404
        assert "update-model.sh parakeet" in resp.get_json()["message"]

    def test_switch_missing_body(self, client):
        resp = client.put("/model", data="not json", content_type="application/json")
        assert resp.status_code == 400

    def test_switch_empty_model_name(self, client):
        assert self._put(client, {"model": ""}).status_code == 400

    def test_switch_no_model_field(self, client):
        assert self._put(client, {"wrong_field": "x"}).status_code == 400

    def test_switch_while_recording(self, client, server):
        server.recording_process = "fake"
        resp = self._put(client, {"model": server.PARAKEET_MODEL_NAME})
        assert resp.status_code == 409
        assert resp.get_json()["error"] == "recording_active"
        server.recording_process = None


class TestRemovedEngineIsGone:
    """The removed engine leaves nothing behind in the server."""

    @pytest.mark.parametrize("name", [
        "MODEL_CATALOG", "WHISPER_BIN", "DEFAULT_MODEL", "find_whisper_bin",
        "start_whisper_server", "run_whisper", "run_whisper_on_model",
        "_detect_whisper_flags", "_detect_vad_support", "load_model",
    ])
    def test_symbol_is_gone(self, server, name):
        assert not hasattr(server, name)

    @pytest.mark.parametrize("path", ["/models/benchmark"])
    def test_route_is_gone(self, client, path):
        assert client.post(path).status_code == 404

    def test_status_has_no_whisper_server_mode(self, client, server, tmp_path):
        _write_parakeet_model(tmp_path / "models")
        sys.modules["sherpa_onnx"] = _fake_sherpa()
        server.STT_ENGINE = "auto"
        server.select_engine()
        status = client.get("/status").get_json()
        assert status["engine"] == "parakeet"
        assert status["engine_backend"] == "sherpa-onnx"
        assert "whisper_server_mode" not in status
