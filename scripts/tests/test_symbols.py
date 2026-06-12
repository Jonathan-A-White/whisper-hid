"""Tests for the symbol replacement feature (spoken words -> symbols)."""

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
    """Load the whisper server module with an isolated symbols file."""
    mod = _load_server_module()
    mod.SYMBOLS_FILE = str(tmp_path / "symbol-replacements.json")
    return mod


def _enable(server, entries):
    server.symbol_settings = {"enabled": True, "entries": entries}


class TestApplySymbols:
    """Test the apply_symbols function."""

    def test_disabled_returns_unchanged(self, server):
        server.symbol_settings = {
            "enabled": False,
            "entries": [{"phrase": "dash", "symbol": "-", "spacing": "both"}],
        }
        assert server.apply_symbols("foo dash bar") == "foo dash bar"

    def test_join_both(self, server):
        _enable(server, [{"phrase": "dash", "symbol": "-", "spacing": "both"}])
        assert server.apply_symbols("foo dash bar") == "foo-bar"

    def test_join_both_at_start(self, server):
        _enable(server, [{"phrase": "forward slash", "symbol": "/", "spacing": "both"}])
        assert server.apply_symbols("forward slash help") == "/help"

    def test_join_left(self, server):
        _enable(server, [{"phrase": "colon", "symbol": ":", "spacing": "left"}])
        assert server.apply_symbols("key colon value") == "key: value"

    def test_join_right(self, server):
        _enable(server, [{"phrase": "open paren", "symbol": "(", "spacing": "right"}])
        assert server.apply_symbols("foo open paren bar") == "foo (bar"

    def test_keep_spaces(self, server):
        _enable(server, [{"phrase": "arrow", "symbol": "->", "spacing": "none"}])
        assert server.apply_symbols("a arrow b") == "a -> b"

    def test_case_insensitive(self, server):
        _enable(server, [{"phrase": "dash", "symbol": "-", "spacing": "both"}])
        assert server.apply_symbols("Dash foo") == "-foo"
        assert server.apply_symbols("foo DASH bar") == "foo-bar"

    def test_whole_word_only(self, server):
        _enable(server, [{"phrase": "dash", "symbol": "-", "spacing": "both"}])
        # "dashboard" contains "dash" but must NOT be replaced
        assert server.apply_symbols("open the dashboard now") == "open the dashboard now"

    def test_longest_phrase_wins(self, server):
        _enable(server, [
            {"phrase": "slash", "symbol": "/", "spacing": "both"},
            {"phrase": "back slash", "symbol": "\\", "spacing": "both"},
        ])
        assert server.apply_symbols("foo back slash bar") == "foo\\bar"

    def test_backslash_symbol_is_literal(self, server):
        # "\" must not be interpreted as a regex escape in the replacement
        _enable(server, [{"phrase": "back slash", "symbol": "\\", "spacing": "both"}])
        assert server.apply_symbols("a back slash b") == "a\\b"

    def test_multiple_occurrences(self, server):
        _enable(server, [{"phrase": "dot", "symbol": ".", "spacing": "both"}])
        assert server.apply_symbols("example dot com dot org") == "example.com.org"

    def test_multiple_entries_chain(self, server):
        _enable(server, [
            {"phrase": "forward slash", "symbol": "/", "spacing": "both"},
            {"phrase": "dash", "symbol": "-", "spacing": "both"},
        ])
        assert server.apply_symbols("forward slash my dash command") == "/my-command"

    def test_empty_text(self, server):
        _enable(server, [{"phrase": "dash", "symbol": "-", "spacing": "both"}])
        assert server.apply_symbols("") == ""

    def test_no_entries(self, server):
        _enable(server, [])
        assert server.apply_symbols("foo dash bar") == "foo dash bar"


class TestLoadSaveSymbols:
    """Test loading and saving the symbols file."""

    def test_missing_file_materializes_defaults(self, server):
        assert not os.path.isfile(server.SYMBOLS_FILE)
        server.load_symbols()
        # Defaults loaded in memory, disabled by default
        assert server.symbol_settings["enabled"] is False
        assert server.symbol_settings["entries"] == server.DEFAULT_SYMBOLS
        # ...and written to disk so individual entries can be edited/deleted
        assert os.path.isfile(server.SYMBOLS_FILE)
        with open(server.SYMBOLS_FILE) as f:
            data = json.load(f)
        assert data["entries"] == server.DEFAULT_SYMBOLS

    def test_load_from_file(self, server):
        config = {
            "enabled": True,
            "entries": [{"phrase": "dash", "symbol": "-", "spacing": "both"}],
        }
        with open(server.SYMBOLS_FILE, "w") as f:
            json.dump(config, f)
        server.load_symbols()
        assert server.symbol_settings == config

    def test_load_skips_invalid_entries(self, server):
        config = {
            "enabled": True,
            "entries": [
                {"phrase": "dash", "symbol": "-", "spacing": "both"},
                {"phrase": "", "symbol": "-"},          # empty phrase
                {"phrase": "dot"},                       # missing symbol
                {"phrase": "x", "symbol": "y", "spacing": "diagonal"},  # bad spacing
                "not a dict",
            ],
        }
        with open(server.SYMBOLS_FILE, "w") as f:
            json.dump(config, f)
        server.load_symbols()
        assert server.symbol_settings["entries"] == [
            {"phrase": "dash", "symbol": "-", "spacing": "both"}
        ]

    def test_load_invalid_json_falls_back_to_defaults(self, server):
        with open(server.SYMBOLS_FILE, "w") as f:
            f.write("not json{{{")
        server.load_symbols()
        assert server.symbol_settings["enabled"] is False
        assert server.symbol_settings["entries"] == server.DEFAULT_SYMBOLS
        # Corrupt file is left alone, not overwritten
        with open(server.SYMBOLS_FILE) as f:
            assert f.read() == "not json{{{"

    def test_save_and_reload(self, server):
        _enable(server, [{"phrase": "pipe", "symbol": "|", "spacing": "both"}])
        server.save_symbols()
        server.symbol_settings = {"enabled": False, "entries": []}
        server.load_symbols()
        assert server.symbol_settings == {
            "enabled": True,
            "entries": [{"phrase": "pipe", "symbol": "|", "spacing": "both"}],
        }

    def test_default_spacings_are_valid(self, server):
        for entry in server.DEFAULT_SYMBOLS:
            assert server._valid_symbol_entry(entry), entry


class TestPostprocessIntegration:
    """Symbols are applied after word corrections in _postprocess_text."""

    def test_corrections_then_symbols(self, server):
        server.word_corrections = {"ford slash": "forward slash"}
        _enable(server, [{"phrase": "forward slash", "symbol": "/", "spacing": "both"}])
        assert server._postprocess_text("ford slash help", "test") == "/help"

    def test_symbols_skipped_when_disabled(self, server):
        server.word_corrections = {}
        server.symbol_settings = {
            "enabled": False,
            "entries": [{"phrase": "dash", "symbol": "-", "spacing": "both"}],
        }
        assert server._postprocess_text("foo dash bar", "test") == "foo dash bar"


class TestSymbolsAPI:
    """Test the /symbols API endpoints."""

    @pytest.fixture
    def client(self, server):
        server.load_symbols()
        server.app.config["TESTING"] = True
        return server.app.test_client(), server

    def test_get_symbols(self, client):
        c, server = client
        resp = c.get("/symbols")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["enabled"] is False
        assert data["entries"] == server.DEFAULT_SYMBOLS

    def test_put_enabled_only_keeps_entries(self, client):
        c, server = client
        resp = c.put(
            "/symbols",
            data=json.dumps({"enabled": True}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["enabled"] is True
        assert data["entries"] == server.DEFAULT_SYMBOLS

    def test_put_entries_replaces_and_persists(self, client):
        c, server = client
        entries = [{"phrase": "dash", "symbol": "-", "spacing": "both"}]
        resp = c.put(
            "/symbols",
            data=json.dumps({"entries": entries}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["entries"] == entries
        # Persisted
        with open(server.SYMBOLS_FILE) as f:
            assert json.load(f)["entries"] == entries

    def test_put_entry_without_spacing_defaults_to_both(self, client):
        c, _ = client
        resp = c.put(
            "/symbols",
            data=json.dumps({"entries": [{"phrase": "pipe", "symbol": "|"}]}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["entries"] == [
            {"phrase": "pipe", "symbol": "|", "spacing": "both"}
        ]

    def test_put_invalid_body(self, client):
        c, _ = client
        resp = c.put("/symbols", data="not json", content_type="application/json")
        assert resp.status_code == 400

    def test_put_non_bool_enabled(self, client):
        c, _ = client
        resp = c.put(
            "/symbols",
            data=json.dumps({"enabled": "yes"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_put_invalid_entry(self, client):
        c, _ = client
        for bad in (
            [{"phrase": "", "symbol": "-"}],
            [{"phrase": "dash"}],
            [{"phrase": "dash", "symbol": "-", "spacing": "diagonal"}],
            "not a list",
        ):
            resp = c.put(
                "/symbols",
                data=json.dumps({"entries": bad}),
                content_type="application/json",
            )
            assert resp.status_code == 400, bad

    def test_reset_restores_defaults_keeps_enabled(self, client):
        c, server = client
        c.put(
            "/symbols",
            data=json.dumps({"enabled": True, "entries": []}),
            content_type="application/json",
        )
        resp = c.post("/symbols/reset")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["enabled"] is True
        assert data["entries"] == server.DEFAULT_SYMBOLS
