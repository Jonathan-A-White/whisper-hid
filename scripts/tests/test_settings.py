"""Tests for the /settings API endpoints."""

import importlib.util
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _load_server_module():
    """Import whisper-server.py as a module."""
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server_settings", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def server():
    """Load the whisper server module."""
    return _load_server_module()


@pytest.fixture
def client(server):
    server._init_runtime_settings()
    server.app.config["TESTING"] = True
    return server.app.test_client()


class TestGetSettings:
    """Test GET /settings."""

    def test_returns_defaults(self, client):
        resp = client.get("/settings")
        assert resp.status_code == 200
        data = resp.get_json()
        assert "noise_reduction" in data
        assert isinstance(data["noise_reduction"], bool)

    def test_default_noise_reduction_false(self, server, client):
        # Default env var is "0", so noise_reduction should be False
        server.NOISE_REDUCTION = False
        server._init_runtime_settings()
        resp = client.get("/settings")
        assert resp.get_json()["noise_reduction"] is False


class TestPutSettings:
    """Test PUT /settings."""

    def test_enable_noise_reduction(self, client):
        resp = client.put(
            "/settings",
            data=json.dumps({"noise_reduction": True}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["noise_reduction"] is True

        # Verify it persists
        resp2 = client.get("/settings")
        assert resp2.get_json()["noise_reduction"] is True

    def test_disable_noise_reduction(self, client):
        # Enable first
        client.put(
            "/settings",
            data=json.dumps({"noise_reduction": True}),
            content_type="application/json",
        )
        # Disable
        resp = client.put(
            "/settings",
            data=json.dumps({"noise_reduction": False}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["noise_reduction"] is False

    def test_invalid_body_not_json(self, client):
        resp = client.put(
            "/settings",
            data="not json",
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_invalid_body_not_object(self, client):
        resp = client.put(
            "/settings",
            data=json.dumps([1, 2, 3]),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_invalid_noise_reduction_type(self, client):
        resp = client.put(
            "/settings",
            data=json.dumps({"noise_reduction": "yes"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_unknown_keys_ignored(self, client):
        resp = client.put(
            "/settings",
            data=json.dumps({"noise_reduction": True, "unknown_key": 42}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["noise_reduction"] is True
        assert "unknown_key" not in data

    def test_empty_object_no_change(self, client):
        # Set noise_reduction to True first
        client.put(
            "/settings",
            data=json.dumps({"noise_reduction": True}),
            content_type="application/json",
        )
        # PUT empty object — no change
        resp = client.put(
            "/settings",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["noise_reduction"] is True


class TestGetNoiseReduction:
    """Test the get_noise_reduction() helper."""

    def test_reflects_runtime_setting(self, server):
        server._init_runtime_settings()
        assert server.get_noise_reduction() is False

        server.runtime_settings["noise_reduction"] = True
        assert server.get_noise_reduction() is True

        server.runtime_settings["noise_reduction"] = False
        assert server.get_noise_reduction() is False
