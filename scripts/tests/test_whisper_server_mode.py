"""Tests for persistent whisper-server mode (model loaded once)."""

import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from unittest.mock import patch, MagicMock

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
    """Load the whisper server module (fresh for each test)."""
    mod = _load_server_module()
    # Reset server mode state
    mod._whisper_server_proc = None
    mod._whisper_server_mode = False
    yield mod
    # Cleanup
    mod.stop_whisper_server()


class TestFindWhisperServerBin:
    """Test whisper-server binary discovery."""

    def test_not_found(self, server, tmp_path):
        server.INSTALL_DIR = str(tmp_path)
        assert server.find_whisper_server_bin() == ""

    def test_finds_whisper_server(self, server, tmp_path):
        bin_dir = tmp_path / "whisper.cpp" / "build" / "bin"
        bin_dir.mkdir(parents=True)
        server_bin = bin_dir / "whisper-server"
        server_bin.write_text("#!/bin/sh\n")
        server_bin.chmod(0o755)
        server.INSTALL_DIR = str(tmp_path)
        assert server.find_whisper_server_bin() == str(server_bin)

    def test_finds_legacy_server(self, server, tmp_path):
        bin_dir = tmp_path / "whisper.cpp" / "build" / "bin"
        bin_dir.mkdir(parents=True)
        server_bin = bin_dir / "server"
        server_bin.write_text("#!/bin/sh\n")
        server_bin.chmod(0o755)
        server.INSTALL_DIR = str(tmp_path)
        assert server.find_whisper_server_bin() == str(server_bin)

    def test_prefers_whisper_server_over_server(self, server, tmp_path):
        bin_dir = tmp_path / "whisper.cpp" / "build" / "bin"
        bin_dir.mkdir(parents=True)
        for name in ["whisper-server", "server"]:
            f = bin_dir / name
            f.write_text("#!/bin/sh\n")
            f.chmod(0o755)
        server.INSTALL_DIR = str(tmp_path)
        assert server.find_whisper_server_bin().endswith("whisper-server")


class TestIsWhisperServerAlive:
    """Test server liveness check."""

    def test_not_alive_when_no_process(self, server):
        assert server._is_whisper_server_alive() is False

    def test_not_alive_when_mode_off(self, server):
        server._whisper_server_proc = MagicMock()
        server._whisper_server_proc.poll.return_value = None
        server._whisper_server_mode = False
        assert server._is_whisper_server_alive() is False

    def test_alive_when_running(self, server):
        server._whisper_server_proc = MagicMock()
        server._whisper_server_proc.poll.return_value = None
        server._whisper_server_mode = True
        assert server._is_whisper_server_alive() is True

    def test_not_alive_when_exited(self, server):
        server._whisper_server_proc = MagicMock()
        server._whisper_server_proc.poll.return_value = 1
        server._whisper_server_mode = True
        assert server._is_whisper_server_alive() is False


class TestStartWhisperServer:
    """Test starting the persistent whisper-server."""

    def test_returns_false_when_no_binary(self, server, tmp_path):
        server.INSTALL_DIR = str(tmp_path)
        result = server.start_whisper_server("/fake/model.bin")
        assert result is False
        assert server._whisper_server_mode is False

    @patch("subprocess.Popen")
    def test_returns_false_on_popen_error(self, mock_popen, server, tmp_path):
        # Create a fake binary so find_whisper_server_bin succeeds
        bin_dir = tmp_path / "whisper.cpp" / "build" / "bin"
        bin_dir.mkdir(parents=True)
        server_bin = bin_dir / "whisper-server"
        server_bin.write_text("#!/bin/sh\n")
        server_bin.chmod(0o755)
        server.INSTALL_DIR = str(tmp_path)
        server._whisper_extra_flags = []

        mock_popen.side_effect = OSError("mock error")
        result = server.start_whisper_server("/fake/model.bin")
        assert result is False


class TestStopWhisperServer:
    """Test stopping the persistent whisper-server."""

    def test_stop_when_no_process(self, server):
        # Should not raise
        server.stop_whisper_server()
        assert server._whisper_server_mode is False

    def test_stop_running_process(self, server):
        mock_proc = MagicMock()
        mock_proc.terminate.return_value = None
        mock_proc.wait.return_value = 0
        mock_proc.pid = 12345
        server._whisper_server_proc = mock_proc
        server._whisper_server_mode = True

        server.stop_whisper_server()

        mock_proc.terminate.assert_called_once()
        assert server._whisper_server_proc is None
        assert server._whisper_server_mode is False

    def test_stop_kills_on_timeout(self, server):
        mock_proc = MagicMock()
        mock_proc.terminate.return_value = None
        mock_proc.wait.side_effect = [subprocess.TimeoutExpired("cmd", 5), None]
        mock_proc.kill.return_value = None
        mock_proc.pid = 12345
        server._whisper_server_proc = mock_proc
        server._whisper_server_mode = True

        server.stop_whisper_server()

        mock_proc.terminate.assert_called_once()
        mock_proc.kill.assert_called_once()
        assert server._whisper_server_proc is None


class TestTranscribeViaServer:
    """Test HTTP transcription via persistent server."""

    def _start_mock_server(self, response_text=" Hello world.", port=0):
        """Start a tiny HTTP server that mimics whisper-server /inference."""
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"text": response_text}).encode())

            def log_message(self, format, *args):
                pass  # suppress logs

        srv = HTTPServer(("127.0.0.1", port), Handler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        return srv

    def test_transcribe_returns_text(self, server, tmp_path):
        srv = self._start_mock_server(" Hello world.")
        port = srv.server_address[1]
        server.WHISPER_SERVER_PORT = port

        wav_file = tmp_path / "test.wav"
        wav_file.write_bytes(b"\x00" * 100)

        text, duration_ms = server._transcribe_via_server(str(wav_file))
        assert text == "Hello world."
        assert duration_ms >= 0
        srv.shutdown()

    def test_transcribe_strips_whitespace(self, server, tmp_path):
        srv = self._start_mock_server("  transcribed text  ")
        port = srv.server_address[1]
        server.WHISPER_SERVER_PORT = port

        wav_file = tmp_path / "test.wav"
        wav_file.write_bytes(b"\x00" * 100)

        text, _ = server._transcribe_via_server(str(wav_file))
        assert text == "transcribed text"
        srv.shutdown()

    def test_transcribe_empty_response(self, server, tmp_path):
        srv = self._start_mock_server("")
        port = srv.server_address[1]
        server.WHISPER_SERVER_PORT = port

        wav_file = tmp_path / "test.wav"
        wav_file.write_bytes(b"\x00" * 100)

        text, _ = server._transcribe_via_server(str(wav_file))
        assert text == ""
        srv.shutdown()


class TestRunWhisperServerMode:
    """Test run_whisper with server mode active."""

    def _start_mock_server(self, response_text=" Hello world.", port=0):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"text": response_text}).encode())

            def log_message(self, format, *args):
                pass

        srv = HTTPServer(("127.0.0.1", port), Handler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        return srv

    def test_uses_server_when_alive(self, server, tmp_path):
        srv = self._start_mock_server(" Hello from server.")
        port = srv.server_address[1]
        server.WHISPER_SERVER_PORT = port

        # Simulate active server mode
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        server._whisper_server_proc = mock_proc
        server._whisper_server_mode = True
        server.model_path = "/fake/model.bin"
        server.word_corrections = {}

        wav_file = tmp_path / "test.wav"
        wav_file.write_bytes(b"\x00" * 100)

        text, duration_ms = server.run_whisper(str(wav_file))
        assert text == "Hello from server."
        assert duration_ms >= 0
        srv.shutdown()

    def test_applies_corrections_in_server_mode(self, server, tmp_path):
        srv = self._start_mock_server(" ask quad about it")
        port = srv.server_address[1]
        server.WHISPER_SERVER_PORT = port

        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        server._whisper_server_proc = mock_proc
        server._whisper_server_mode = True
        server.model_path = "/fake/model.bin"
        server.word_corrections = {"quad": "Claude"}

        wav_file = tmp_path / "test.wav"
        wav_file.write_bytes(b"\x00" * 100)

        text, _ = server.run_whisper(str(wav_file))
        assert text == "ask Claude about it"
        srv.shutdown()

    def test_filters_silence_markers_in_server_mode(self, server, tmp_path):
        srv = self._start_mock_server("[BLANK_AUDIO]")
        port = srv.server_address[1]
        server.WHISPER_SERVER_PORT = port

        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        server._whisper_server_proc = mock_proc
        server._whisper_server_mode = True
        server.model_path = "/fake/model.bin"
        server.word_corrections = {}

        wav_file = tmp_path / "test.wav"
        wav_file.write_bytes(b"\x00" * 100)

        text, _ = server.run_whisper(str(wav_file))
        assert text == ""
        srv.shutdown()


class TestStatusEndpoint:
    """Test /status includes whisper_server_mode."""

    def test_status_includes_server_mode(self, server):
        server.model_loaded = True
        server.model_name = "base.en"
        server.model_size_mb = 142
        server.recording_process = None
        server._whisper_server_proc = None
        server._whisper_server_mode = False

        server.app.config["TESTING"] = True
        client = server.app.test_client()
        resp = client.get("/status")
        data = resp.get_json()
        assert "whisper_server_mode" in data
        assert data["whisper_server_mode"] is False

    def test_status_server_mode_active(self, server):
        server.model_loaded = True
        server.model_name = "base.en"
        server.model_size_mb = 142
        server.recording_process = None

        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        server._whisper_server_proc = mock_proc
        server._whisper_server_mode = True

        server.app.config["TESTING"] = True
        client = server.app.test_client()
        resp = client.get("/status")
        data = resp.get_json()
        assert data["whisper_server_mode"] is True


class TestWaitForWhisperServer:
    """Test the server readiness check."""

    def test_returns_true_when_port_open(self, server):
        # Bind a temporary socket to mimic a listening server
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        port = sock.getsockname()[1]
        server.WHISPER_SERVER_PORT = port

        # Need a mock process that appears to be running
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        server._whisper_server_proc = mock_proc

        result = server._wait_for_whisper_server(timeout=2)
        assert result is True
        sock.close()

    def test_returns_false_when_process_exits(self, server):
        server.WHISPER_SERVER_PORT = 19999  # unlikely to be in use
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 1  # process exited
        server._whisper_server_proc = mock_proc

        result = server._wait_for_whisper_server(timeout=1)
        assert result is False

    def test_returns_false_on_timeout(self, server):
        server.WHISPER_SERVER_PORT = 19999  # unlikely to be in use
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None  # process running but port closed
        server._whisper_server_proc = mock_proc

        result = server._wait_for_whisper_server(timeout=1)
        assert result is False
