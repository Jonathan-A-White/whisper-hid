"""Tests for the target app mode (Claude Code / Codex / plain text).

The mode decides how a line break is typed on the host, and it also colours
the cleanup "prompt" style and the glossary/corrections vocabulary.
"""

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
    """Load the whisper server module with an isolated target file."""
    mod = _load_server_module()
    mod.TARGET_FILE = str(tmp_path / "target-settings.json")
    mod.target_settings = {"target": "plain"}
    mod.word_corrections = {}
    mod.symbol_settings = {"enabled": False, "entries": []}
    return mod


@pytest.fixture
def client(server):
    server.app.config["TESTING"] = True
    return server.app.test_client()


class TestNewlineModes:
    """Each target maps to the HID service's newline_mode wire value."""

    def test_plain_types_a_real_enter(self, server):
        server.target_settings = {"target": "plain"}
        assert server.target_profile()["newline_mode"] == "enter"

    def test_claude_types_backslash_enter(self, server):
        server.target_settings = {"target": "claude"}
        assert server.target_profile()["newline_mode"] == "backslash_enter"

    def test_codex_types_ctrl_j(self, server):
        server.target_settings = {"target": "codex"}
        assert server.target_profile()["newline_mode"] == "ctrl_j"

    def test_every_profile_declares_a_newline_mode(self, server):
        valid = {"enter", "ctrl_j", "backslash_enter"}
        for name, profile in server.TARGET_PROFILES.items():
            assert profile["newline_mode"] in valid, name


class TestSubmitNewlineModes:
    """The deliberate final Enter is its own per-target keystroke problem."""

    def test_plain_and_claude_submit_with_a_bare_enter(self, server):
        for target in ("plain", "claude"):
            server.target_settings = {"target": target}
            assert server.target_profile()["submit_newline_mode"] == "enter"

    def test_codex_presses_end_before_the_enter(self, server):
        # Codex CLI holds fast keystrokes as a paste and turns an Enter that
        # arrives in that state into a newline; End clears it.
        server.target_settings = {"target": "codex"}
        assert server.target_profile()["submit_newline_mode"] == "end_enter"

    def test_no_target_submits_with_a_soft_newline(self, server):
        # A submit mode that doesn't submit would silently lose every
        # dictation, so keep the soft-newline modes out of this field.
        soft = {"ctrl_j", "backslash_enter"}
        for name, profile in server.TARGET_PROFILES.items():
            assert profile["submit_newline_mode"] not in soft, name

    def test_every_profile_declares_a_submit_newline_mode(self, server):
        valid = {"enter", "end_enter"}
        for name, profile in server.TARGET_PROFILES.items():
            assert profile["submit_newline_mode"] in valid, name


class TestPersistence:
    def test_unknown_target_falls_back_to_default(self, server):
        server.target_settings = {"target": "emacs"}
        assert server.active_target() == server.DEFAULT_TARGET

    def test_save_and_load_round_trip(self, server):
        server.target_settings = {"target": "codex"}
        server.save_target_settings()
        server.target_settings = {"target": "plain"}
        server.load_target_settings()
        assert server.active_target() == "codex"

    def test_missing_file_loads_default(self, server):
        server.load_target_settings()
        assert server.active_target() == server.DEFAULT_TARGET

    def test_corrupt_file_loads_default(self, server):
        with open(server.TARGET_FILE, "w") as f:
            f.write("{not json")
        server.load_target_settings()
        assert server.active_target() == server.DEFAULT_TARGET

    def test_unknown_target_in_file_is_ignored(self, server):
        with open(server.TARGET_FILE, "w") as f:
            json.dump({"target": "vim"}, f)
        server.load_target_settings()
        assert server.active_target() == server.DEFAULT_TARGET


class TestTargetApi:
    def test_get_returns_active_and_catalog(self, client, server):
        server.target_settings = {"target": "claude"}
        res = client.get("/target")
        assert res.status_code == 200
        body = res.get_json()
        assert body["target"] == "claude"
        assert body["newline_mode"] == "backslash_enter"
        assert body["submit_newline_mode"] == "enter"
        assert {t["name"] for t in body["targets"]} == set(server.TARGET_PROFILES)
        codex = next(t for t in body["targets"] if t["name"] == "codex")
        assert codex["submit_newline_mode"] == "end_enter"

    def test_put_sets_and_persists(self, client, server):
        res = client.put("/target", json={"target": "codex"})
        assert res.status_code == 200
        assert res.get_json()["target"] == "codex"
        assert server.active_target() == "codex"
        with open(server.TARGET_FILE) as f:
            assert json.load(f)["target"] == "codex"

    def test_put_rejects_unknown_target(self, client, server):
        res = client.put("/target", json={"target": "nano"})
        assert res.status_code == 400
        assert res.get_json()["error"] == "invalid_target"
        assert server.active_target() == "plain"

    def test_put_rejects_missing_target(self, client):
        assert client.put("/target", json={}).status_code == 400

    def test_status_reports_the_target(self, client, server):
        server.model_loaded = True
        server.target_settings = {"target": "codex"}
        body = client.get("/status").get_json()
        assert body["target"] == "codex"
        assert body["target_newline_mode"] == "ctrl_j"
        assert body["target_submit_newline_mode"] == "end_enter"


class TestCleanupStyleWording:
    """The "prompt" style is written for whichever assistant is targeted."""

    def test_claude_named_in_prompt_style(self, server):
        server.target_settings = {"target": "claude"}
        server.cleanup_settings = {"enabled": True, "style": "prompt"}
        system = server._build_cleanup_messages("do a thing")[0]["content"]
        assert "Claude Code" in system
        assert "Codex" not in system

    def test_codex_named_in_prompt_style(self, server):
        server.target_settings = {"target": "codex"}
        server.cleanup_settings = {"enabled": True, "style": "prompt"}
        system = server._build_cleanup_messages("do a thing")[0]["content"]
        assert "Codex" in system
        assert "Claude" not in system

    def test_no_placeholder_survives_into_the_prompt(self, server):
        for target in server.TARGET_PROFILES:
            server.target_settings = {"target": target}
            for style in server.CLEANUP_STYLES:
                server.cleanup_settings = {"enabled": True, "style": style}
                system = server._build_cleanup_messages("x")[0]["content"]
                assert "{assistant}" not in system, (target, style)
                assert "{short}" not in system, (target, style)

    def test_style_label_follows_the_target(self, server):
        server.target_settings = {"target": "codex"}
        labels = {s["name"]: s["label"] for s in server._cleanup_state()["styles"]}
        assert labels["prompt"] == "Codex prompt"
        server.target_settings = {"target": "claude"}
        labels = {s["name"]: s["label"] for s in server._cleanup_state()["styles"]}
        assert labels["prompt"] == "Claude prompt"


class TestTargetVocabulary:
    """Glossary terms and built-in corrections follow the target."""

    def test_target_terms_lead_the_glossary(self, server):
        server.target_settings = {"target": "codex"}
        server.word_corrections = {"quad": "Claude"}
        terms = server._glossary_terms()
        assert terms[:2] == ["Codex", "Codex CLI"]
        assert "Claude" in terms

    def test_plain_target_adds_no_terms(self, server):
        server.target_settings = {"target": "plain"}
        server.word_corrections = {"quad": "Claude"}
        assert server._glossary_terms() == ["Claude"]

    def test_glossary_stays_capped_at_40(self, server):
        server.target_settings = {"target": "claude"}
        server.word_corrections = {f"w{i}": f"Term{i}" for i in range(60)}
        assert len(server._glossary_terms()) == 40

    def test_builtin_corrections_apply_for_the_target(self, server):
        server.target_settings = {"target": "claude"}
        assert server.apply_corrections("ask cloud code to fix it") == (
            "ask Claude Code to fix it"
        )
        server.target_settings = {"target": "codex"}
        assert server.apply_corrections("ask code x to fix it") == (
            "ask Codex to fix it"
        )

    def test_other_targets_builtins_do_not_apply(self, server):
        server.target_settings = {"target": "codex"}
        assert server.apply_corrections("cloud code") == "cloud code"

    def test_plain_target_has_no_builtins(self, server):
        server.target_settings = {"target": "plain"}
        assert server.apply_corrections("cloud code and code x") == (
            "cloud code and code x"
        )

    def test_user_entry_overrides_a_builtin(self, server):
        server.target_settings = {"target": "claude"}
        server.word_corrections = {"cloud code": "cloud code"}
        assert server.apply_corrections("cloud code") == "cloud code"

    def test_user_entries_still_apply_alongside_builtins(self, server):
        server.target_settings = {"target": "claude"}
        server.word_corrections = {"quad": "Claude"}
        assert server.apply_corrections("quad in cloud code") == (
            "Claude in Claude Code"
        )
