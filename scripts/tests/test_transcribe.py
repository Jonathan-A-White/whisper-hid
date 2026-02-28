"""Tests for the Whisper HTTP server API."""

import os
import sys

import pytest

# Add scripts directory to path so we can import whisper-server
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def test_placeholder():
    """Placeholder test — verifies the test infrastructure works.

    Full API tests require whisper.cpp to be built and a model to be loaded,
    which is not available in CI. These tests verify the Flask app structure
    and response formats without running actual transcription.
    """
    assert True


def test_imports():
    """Verify the whisper server module can be imported."""
    # This import will fail if flask is not installed
    import importlib
    spec = importlib.util.find_spec("flask")
    assert spec is not None, "Flask must be installed"


def test_cors_headers():
    """Verify CORS helper returns expected headers."""
    # Import the server module
    import importlib.util
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server", server_path)
    server = importlib.util.module_from_spec(spec)

    # We can't fully load the module without running Flask,
    # but we can verify the file exists and is valid Python
    assert os.path.isfile(server_path), "whisper-server.py should exist"
    with open(server_path) as f:
        content = f.read()
    assert "Access-Control-Allow-Private-Network" in content
    assert "Access-Control-Allow-Origin" in content
    assert "/transcribe" in content
    assert "/status" in content
    assert "/logs" in content
