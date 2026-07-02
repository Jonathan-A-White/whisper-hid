"""Tests for the speech cleanup feature (local LLM post-processing)."""

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
def server(tmp_path):
    """Load the whisper server module with isolated settings files."""
    mod = _load_server_module()
    mod.CLEANUP_SETTINGS_FILE = str(tmp_path / "cleanup-settings.json")
    mod.SYMBOLS_FILE = str(tmp_path / "symbol-replacements.json")
    mod.word_corrections = {}
    mod.symbol_settings = {"enabled": False, "entries": []}
    return mod


def _arm(server, reply):
    """Enable cleanup with a fake llama-server that returns `reply`."""
    server.cleanup_settings = {"enabled": True}
    server._is_cleanup_server_alive = lambda: True
    server._cleanup_request = lambda text: reply


class TestApplyCleanup:
    """Test apply_cleanup and its fallback guards."""

    def test_disabled_returns_unchanged(self, server):
        server.cleanup_settings = {"enabled": False}
        server._cleanup_request = lambda text: pytest.fail("must not be called")
        assert server.apply_cleanup("um hello there") == "um hello there"

    def test_empty_text_returns_unchanged(self, server):
        _arm(server, "should not matter")
        assert server.apply_cleanup("") == ""

    def test_applies_cleaned_text(self, server):
        _arm(server, "I think we should start with the login page.")
        raw = "so um I think we should uh start with the the login page"
        assert server.apply_cleanup(raw) == "I think we should start with the login page."

    def test_skipped_while_symbol_mode_on(self, server):
        _arm(server, "mangled")
        server.symbol_settings = {"enabled": True, "entries": []}
        assert server.apply_cleanup("forward slash help") == "forward slash help"

    def test_server_not_ready_returns_unchanged(self, server):
        _arm(server, "cleaned")
        server._is_cleanup_server_alive = lambda: False
        assert server.apply_cleanup("um hello") == "um hello"

    def test_request_error_returns_unchanged(self, server):
        server.cleanup_settings = {"enabled": True}
        server._is_cleanup_server_alive = lambda: True

        def boom(text):
            raise OSError("connection refused")

        server._cleanup_request = boom
        assert server.apply_cleanup("um hello") == "um hello"

    def test_empty_response_rejected(self, server):
        _arm(server, "")
        assert server.apply_cleanup("um hello there everyone") == "um hello there everyone"

    def test_truncated_response_rejected(self, server):
        raw = "this is a fairly long dictation about the quarterly report and the numbers"
        _arm(server, "ok")
        assert server.apply_cleanup(raw) == raw

    def test_padded_response_rejected(self, server):
        raw = "short note"
        _arm(server, "Here is the cleaned transcript you asked for: Short note.")
        assert server.apply_cleanup(raw) == raw


class TestCleanupResultGuard:
    def test_bounds(self, server):
        assert server._cleanup_result_ok("a" * 100, "b" * 100)
        assert server._cleanup_result_ok("a" * 100, "b" * 35)
        assert server._cleanup_result_ok("a" * 100, "b" * 160)
        assert not server._cleanup_result_ok("a" * 100, "b" * 34)
        assert not server._cleanup_result_ok("a" * 100, "b" * 161)
        assert not server._cleanup_result_ok("a" * 100, "")


class TestStripThink:
    def test_strips_empty_think_block(self, server):
        assert server._strip_think("<think>\n\n</think>\n\nHello there.") == "Hello there."

    def test_strips_nonempty_think_block(self, server):
        assert server._strip_think("<think>reasoning...</think>Hello.") == "Hello."

    def test_no_block_passthrough(self, server):
        assert server._strip_think("  Hello.  ") == "Hello."


class TestPostprocessIntegration:
    """Cleanup runs before word corrections and symbol replacement."""

    def test_cleanup_then_corrections(self, server):
        _arm(server, "tell quad to fix the bug")
        server.word_corrections = {"quad": "Claude"}
        raw = "um tell quad to uh fix the bug"
        assert server._postprocess_text(raw, "test") == "tell Claude to fix the bug"

    def test_symbol_mode_bypasses_cleanup_but_applies_symbols(self, server):
        _arm(server, "mangled by the llm")
        server.symbol_settings = {
            "enabled": True,
            "entries": [{"phrase": "forward slash", "symbol": "/", "spacing": "both"}],
        }
        assert server._postprocess_text("forward slash help", "test") == "/help"

    def test_disabled_cleanup_leaves_pipeline_untouched(self, server):
        server.cleanup_settings = {"enabled": False}
        assert server._postprocess_text("um hello", "test") == "um hello"


class TestLoadSaveCleanupSettings:
    def test_missing_file_defaults_disabled(self, server):
        assert not os.path.isfile(server.CLEANUP_SETTINGS_FILE)
        server.load_cleanup_settings()
        assert server.cleanup_settings == {"enabled": False, "style": "standard", "model": None}

    def test_save_and_reload(self, server):
        server.cleanup_settings = {"enabled": True, "style": "prompt", "model": "qwen3-4b"}
        server.save_cleanup_settings()
        server.cleanup_settings = dict(server.CLEANUP_DEFAULT_SETTINGS)
        server.load_cleanup_settings()
        assert server.cleanup_settings == {"enabled": True, "style": "prompt", "model": "qwen3-4b"}

    def test_corrupt_file_defaults_disabled(self, server):
        with open(server.CLEANUP_SETTINGS_FILE, "w") as f:
            f.write("not json{{{")
        server.load_cleanup_settings()
        assert server.cleanup_settings == {"enabled": False, "style": "standard", "model": None}

    def test_unknown_style_and_model_fall_back(self, server):
        with open(server.CLEANUP_SETTINGS_FILE, "w") as f:
            json.dump({"enabled": True, "style": "haiku", "model": "gpt-9"}, f)
        server.load_cleanup_settings()
        assert server.cleanup_settings == {"enabled": True, "style": "standard", "model": None}


class TestCleanupAPI:
    @pytest.fixture
    def client(self, server):
        server.load_cleanup_settings()
        server._is_cleanup_server_alive = lambda: True
        server.find_cleanup_model = lambda: "/models/" + server.CLEANUP_MODEL_FILE
        server.app.config["TESTING"] = True
        return server.app.test_client(), server

    def test_get_cleanup(self, client):
        c, server = client
        resp = c.get("/cleanup")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["enabled"] is False
        assert data["available"] is True
        assert data["model"] == server.CLEANUP_MODEL_FILE
        assert data["style"] == "standard"
        assert {s["name"] for s in data["styles"]} == set(server.CLEANUP_STYLES)
        assert [m["name"] for m in data["models"]] == ["qwen3-1.7b", "qwen3-4b"]

    def test_get_cleanup_unavailable(self, client):
        c, server = client
        server._is_cleanup_server_alive = lambda: False
        server.find_cleanup_model = lambda: ""
        data = c.get("/cleanup").get_json()
        assert data["available"] is False
        assert data["model"] is None

    def test_put_cleanup_enables_and_persists(self, client):
        c, server = client
        resp = c.put(
            "/cleanup",
            data=json.dumps({"enabled": True}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["enabled"] is True
        with open(server.CLEANUP_SETTINGS_FILE) as f:
            assert json.load(f)["enabled"] is True

    def test_put_cleanup_invalid_body(self, client):
        c, _ = client
        for bad in ("not json", json.dumps({}), json.dumps({"enabled": "yes"})):
            resp = c.put("/cleanup", data=bad, content_type="application/json")
            assert resp.status_code == 400, bad

    def test_status_includes_cleanup_fields(self, client):
        c, server = client
        server.model_loaded = True
        server.cleanup_settings = {"enabled": True, "style": "prompt", "model": None}
        data = c.get("/status").get_json()
        assert data["cleanup_mode"] is True
        assert data["cleanup_available"] is True
        assert data["cleanup_style"] == "prompt"


class TestStyles:
    @pytest.fixture
    def client(self, server):
        server.load_cleanup_settings()
        server._is_cleanup_server_alive = lambda: True
        server.app.config["TESTING"] = True
        return server.app.test_client(), server

    def test_put_style_persists(self, client):
        c, server = client
        resp = c.put(
            "/cleanup",
            data=json.dumps({"style": "commit"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["style"] == "commit"
        with open(server.CLEANUP_SETTINGS_FILE) as f:
            assert json.load(f)["style"] == "commit"

    def test_put_invalid_style_rejected(self, client):
        c, _ = client
        resp = c.put(
            "/cleanup",
            data=json.dumps({"style": "sonnet"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_build_messages_uses_active_style(self, server):
        server.cleanup_settings = {"enabled": True, "style": "prompt", "model": None}
        messages = server._build_cleanup_messages("do the thing")
        assert "coding assistant" in messages[0]["content"]
        assert messages[-1] == {"role": "user", "content": "do the thing"}

    def test_glossary_injected_from_corrections(self, server):
        server.word_corrections = {"quad": "Claude", "termix": "Termux", "cloud": "Claude"}
        messages = server._build_cleanup_messages("hello")
        system = messages[0]["content"]
        assert "Claude" in system and "Termux" in system
        # deduped case-insensitively: "Claude" appears once in the term list
        assert system.count("Claude, Termux") == 1

    def test_no_glossary_without_corrections(self, server):
        server.word_corrections = {}
        messages = server._build_cleanup_messages("hello")
        assert "speaker often uses these terms" not in messages[0]["content"]

    def test_style_ratio_window_applies(self, server):
        # A commit-style rewrite legitimately compresses a ramble far below
        # the standard 0.35 floor.
        raw = "x" * 200
        _arm(server, "y" * 40)  # ratio 0.2
        server.cleanup_settings = {"enabled": True, "style": "standard", "model": None}
        assert server.apply_cleanup(raw) == raw  # rejected under standard
        server.cleanup_settings = {"enabled": True, "style": "commit", "model": None}
        assert server.apply_cleanup(raw) == "y" * 40  # accepted under commit


class TestModelSelection:
    @pytest.fixture
    def client(self, server):
        server.load_cleanup_settings()
        server._is_cleanup_server_alive = lambda: True
        server.app.config["TESTING"] = True
        return server.app.test_client(), server

    def test_active_model_defaults_to_env_file(self, server):
        server.cleanup_settings = dict(server.CLEANUP_DEFAULT_SETTINGS)
        assert server.active_cleanup_model_file() == server.CLEANUP_MODEL_FILE

    def test_selection_wins_when_downloaded(self, server):
        server._cleanup_model_present = lambda f: True
        server.cleanup_settings = {"enabled": False, "style": "standard", "model": "qwen3-4b"}
        assert server.active_cleanup_model_file() == "Qwen3-4B-Q4_K_M.gguf"

    def test_selection_ignored_when_missing(self, server):
        server._cleanup_model_present = lambda f: False
        server.cleanup_settings = {"enabled": False, "style": "standard", "model": "qwen3-4b"}
        assert server.active_cleanup_model_file() == server.CLEANUP_MODEL_FILE

    def test_put_model_switches_and_restarts(self, client):
        c, server = client
        server._cleanup_model_present = lambda f: True
        restarts = []
        server.restart_cleanup_server = lambda: restarts.append(True) or True
        resp = c.put(
            "/cleanup",
            data=json.dumps({"model": "qwen3-4b"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["model"] == "Qwen3-4B-Q4_K_M.gguf"
        assert restarts == [True]
        with open(server.CLEANUP_SETTINGS_FILE) as f:
            assert json.load(f)["model"] == "qwen3-4b"

    def test_put_same_model_does_not_restart(self, client):
        c, server = client
        server._cleanup_model_present = lambda f: True
        server.cleanup_settings["model"] = "qwen3-1.7b"
        restarts = []
        server.restart_cleanup_server = lambda: restarts.append(True) or True
        resp = c.put(
            "/cleanup",
            data=json.dumps({"model": "qwen3-1.7b"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert restarts == []

    def test_put_unknown_model_rejected(self, client):
        c, server = client
        resp = c.put(
            "/cleanup",
            data=json.dumps({"model": "gpt-9"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_put_missing_model_404(self, client):
        c, server = client
        server._cleanup_model_present = lambda f: False
        resp = c.put(
            "/cleanup",
            data=json.dumps({"model": "qwen3-4b"}),
            content_type="application/json",
        )
        assert resp.status_code == 404
        assert "update-model.sh" in resp.get_json()["message"]

    def test_models_listing_marks_downloaded_and_active(self, client):
        c, server = client
        server._cleanup_model_present = lambda f: f == "Qwen3-1.7B-Q4_K_M.gguf"
        data = c.get("/cleanup").get_json()
        by_name = {m["name"]: m for m in data["models"]}
        assert by_name["qwen3-1.7b"]["downloaded"] is True
        assert by_name["qwen3-1.7b"]["active"] is True
        assert by_name["qwen3-4b"]["downloaded"] is False
        assert by_name["qwen3-4b"]["active"] is False
