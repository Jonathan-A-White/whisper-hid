"""Tests for mic audio source selection (_mic_record_cmd + /settings)."""

import importlib.util
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _load_server_module():
    """Import whisper-server.py as a module."""
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server_mic_source", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def server():
    mod = _load_server_module()
    mod._init_runtime_settings()
    return mod


@pytest.fixture
def client(server):
    server.app.config["TESTING"] = True
    return server.app.test_client()


@pytest.fixture
def with_api_bin(server, monkeypatch):
    """Pretend the termux-api binary is present."""
    monkeypatch.setattr(server, "_termux_api_bin", "/fake/libexec/termux-api")
    return server


class TestWrapperCommand:
    """The default source keeps using termux-microphone-record verbatim."""

    def test_default_source_uses_wrapper(self, server):
        cmd = server._mic_record_cmd("/tmp/rec.aac", limit_sec=0)
        assert cmd == ["termux-microphone-record", "-f", "/tmp/rec.aac", "-l", "0"]

    def test_wrapper_limit_stays_in_seconds(self, server):
        cmd = server._mic_record_cmd("/tmp/rec.aac", limit_sec=3)
        assert cmd[-1] == "3"

    def test_wrapper_encoder_flags(self, server):
        assert server._mic_record_cmd("/tmp/r.amr", fmt="amr_wb")[-4:] == [
            "-e", "amr_wb", "-b", "23850",
        ]
        assert server._mic_record_cmd("/tmp/r.ogg", fmt="opus")[-2:] == ["-e", "opus"]

    def test_wrapper_used_when_api_bin_missing(self, server, monkeypatch):
        """A selected source without the binary must not break recording."""
        monkeypatch.setattr(server, "_termux_api_bin", None)
        monkeypatch.setattr(server, "_detect_termux_api_bin", lambda: None)
        server.runtime_settings["mic_audio_source"] = "voice_communication"
        assert server._mic_record_cmd("/tmp/rec.aac")[0] == "termux-microphone-record"


class TestDirectApiCommand:
    """A non-default source goes through the termux-api binary."""

    def test_passes_record_action_and_source(self, with_api_bin):
        server = with_api_bin
        server.runtime_settings["mic_audio_source"] = "voice_communication"
        cmd = server._mic_record_cmd("/tmp/rec.aac", limit_sec=0)
        assert cmd[0] == "/fake/libexec/termux-api"
        assert cmd[1] == "MicRecorder"
        # Without "-a record" the service dispatches to its unknown-command
        # handler and nothing is recorded.
        assert cmd[cmd.index("-a") + 1] == "record"
        assert cmd[cmd.index("--ei") + 1] != "source"  # first int extra is limit
        assert "7" in cmd  # AudioSource.VOICE_COMMUNICATION
        assert cmd[cmd.index("file") + 1] == "/tmp/rec.aac"

    def test_limit_converted_to_milliseconds(self, with_api_bin):
        server = with_api_bin
        server.runtime_settings["mic_audio_source"] = "voice_communication"
        cmd = server._mic_record_cmd("/tmp/rec.aac", limit_sec=3)
        assert cmd[cmd.index("limit") + 1] == "3000"

    def test_unlimited_limit_stays_zero(self, with_api_bin):
        server = with_api_bin
        server.runtime_settings["mic_audio_source"] = "voice_communication"
        cmd = server._mic_record_cmd("/tmp/rec.aac", limit_sec=0)
        assert cmd[cmd.index("limit") + 1] == "0"

    def test_source_ids_match_android(self, with_api_bin):
        server = with_api_bin
        for name, expected in (
            ("voice_communication", "7"),
            ("voice_recognition", "6"),
            ("camcorder", "5"),
        ):
            server.runtime_settings["mic_audio_source"] = name
            cmd = server._mic_record_cmd("/tmp/rec.aac")
            assert cmd[cmd.index("source") + 1] == expected

    def test_amr_wb_encoder_and_bitrate(self, with_api_bin):
        server = with_api_bin
        server.runtime_settings["mic_audio_source"] = "voice_communication"
        cmd = server._mic_record_cmd("/tmp/rec.amr", fmt="amr_wb")
        assert cmd[cmd.index("encoder") + 1] == "amr_wb"
        # bps here — the wrapper multiplies its own -b value by 1000.
        assert cmd[cmd.index("bitrate") + 1] == "23850"

    def test_opus_encoder(self, with_api_bin):
        server = with_api_bin
        server.runtime_settings["mic_audio_source"] = "voice_communication"
        cmd = server._mic_record_cmd("/tmp/rec.ogg", fmt="opus")
        assert cmd[cmd.index("encoder") + 1] == "opus"
        assert "bitrate" not in cmd

    def test_mic_source_stays_on_wrapper(self, with_api_bin):
        """Even with the binary available, the default keeps the old path."""
        server = with_api_bin
        server.runtime_settings["mic_audio_source"] = "mic"
        assert server._mic_record_cmd("/tmp/rec.aac")[0] == "termux-microphone-record"


class TestGetMicAudioSource:
    def test_defaults_to_mic(self, server):
        assert server.get_mic_audio_source() == "mic"

    def test_unknown_value_falls_back_to_mic(self, server):
        server.runtime_settings["mic_audio_source"] = "bogus"
        assert server.get_mic_audio_source() == "mic"


class TestSelectableProbe:
    """/status calls this on every poll — it must not re-probe every time."""

    def test_no_reprobe_inside_window(self, server, monkeypatch):
        probes = []
        monkeypatch.setattr(server, "_termux_api_bin", None)
        monkeypatch.setattr(server, "_termux_api_probed_at", server.time.time())
        monkeypatch.setattr(server, "_detect_termux_api_bin", lambda: probes.append(1))
        for _ in range(5):
            assert server._mic_source_selectable() is False
        assert probes == []

    def test_reprobes_after_window(self, server, monkeypatch):
        probes = []
        monkeypatch.setattr(server, "_termux_api_bin", None)
        monkeypatch.setattr(
            server, "_termux_api_probed_at",
            server.time.time() - server.TERMUX_API_REPROBE_SEC - 1,
        )
        monkeypatch.setattr(server, "_detect_termux_api_bin", lambda: probes.append(1))
        server._mic_source_selectable()
        assert probes == [1]

    def test_skips_probe_when_already_found(self, with_api_bin, monkeypatch):
        probes = []
        monkeypatch.setattr(with_api_bin, "_detect_termux_api_bin", lambda: probes.append(1))
        assert with_api_bin._mic_source_selectable() is True
        assert probes == []


class TestSettingsEndpoint:
    def test_get_includes_mic_audio_source(self, client):
        data = client.get("/settings").get_json()
        assert data["mic_audio_source"] == "mic"

    def test_put_accepts_known_source(self, with_api_bin, client):
        resp = client.put(
            "/settings",
            data=json.dumps({"mic_audio_source": "voice_communication"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["mic_audio_source"] == "voice_communication"

    def test_put_rejects_unknown_source(self, with_api_bin, client):
        resp = client.put(
            "/settings",
            data=json.dumps({"mic_audio_source": "telepathy"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert resp.get_json()["error"] == "invalid_value"

    def test_put_rejects_non_string(self, with_api_bin, client):
        resp = client.put(
            "/settings",
            data=json.dumps({"mic_audio_source": 7}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_put_rejects_source_without_api_bin(self, server, client, monkeypatch):
        monkeypatch.setattr(server, "_termux_api_bin", None)
        monkeypatch.setattr(server, "_detect_termux_api_bin", lambda: None)
        resp = client.put(
            "/settings",
            data=json.dumps({"mic_audio_source": "voice_communication"}),
            content_type="application/json",
        )
        assert resp.status_code == 409
        assert server.get_mic_audio_source() == "mic"

    def test_put_allows_mic_without_api_bin(self, server, client, monkeypatch):
        monkeypatch.setattr(server, "_termux_api_bin", None)
        monkeypatch.setattr(server, "_detect_termux_api_bin", lambda: None)
        resp = client.put(
            "/settings",
            data=json.dumps({"mic_audio_source": "mic"}),
            content_type="application/json",
        )
        assert resp.status_code == 200

    def test_noise_reduction_still_works(self, client):
        resp = client.put(
            "/settings",
            data=json.dumps({"noise_reduction": True}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["noise_reduction"] is True
