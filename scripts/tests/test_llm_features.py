"""Tests for the LLM-backed voice edit (/edit) and correction suggestion
(/corrections/suggest) endpoints. The llama-server is never contacted —
the request helpers are faked, mirroring test_cleanup.py."""

import importlib.util
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _load_server_module():
    server_path = os.path.join(os.path.dirname(__file__), "..", "whisper-server.py")
    spec = importlib.util.spec_from_file_location("whisper_server", server_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def server(tmp_path):
    mod = _load_server_module()
    mod.CLEANUP_SETTINGS_FILE = str(tmp_path / "cleanup-settings.json")
    mod.CORRECTIONS_FILE = str(tmp_path / "word-corrections.json")
    mod.word_corrections = {}
    mod._is_cleanup_server_alive = lambda: True
    mod.app.config["TESTING"] = True
    return mod


@pytest.fixture
def client(server):
    return server.app.test_client(), server


class TestEditEndpoint:
    def test_applies_edit(self, client):
        c, server = client
        server._edit_request = lambda text, command: "Send the report to Sarah by Friday."
        resp = c.post(
            "/edit",
            data=json.dumps({
                "text": "Send the report to Mike by Friday.",
                "command": "replace Mike with Sarah",
            }),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["text"] == "Send the report to Sarah by Friday."
        assert "duration_ms" in data

    def test_invalid_bodies_rejected(self, client):
        c, _ = client
        bad_bodies = [
            "not json",
            json.dumps({}),
            json.dumps({"text": "hello"}),
            json.dumps({"command": "delete it"}),
            json.dumps({"text": "", "command": "x"}),
            json.dumps({"text": "x", "command": "   "}),
            json.dumps({"text": 5, "command": "x"}),
        ]
        for bad in bad_bodies:
            resp = c.post("/edit", data=bad, content_type="application/json")
            assert resp.status_code == 400, bad

    def test_llm_unavailable_503(self, client):
        c, server = client
        server._is_cleanup_server_alive = lambda: False
        resp = c.post(
            "/edit",
            data=json.dumps({"text": "hello there", "command": "delete hello"}),
            content_type="application/json",
        )
        assert resp.status_code == 503

    def test_request_error_502(self, client):
        c, server = client

        def boom(text, command):
            raise OSError("connection refused")

        server._edit_request = boom
        resp = c.post(
            "/edit",
            data=json.dumps({"text": "hello there", "command": "delete hello"}),
            content_type="application/json",
        )
        assert resp.status_code == 502

    def test_degenerate_replies_rejected(self, client):
        c, server = client
        for reply in ("", "x" * 2000):
            server._edit_request = lambda text, command, r=reply: r
            resp = c.post(
                "/edit",
                data=json.dumps({"text": "short text", "command": "fix it"}),
                content_type="application/json",
            )
            assert resp.status_code == 502, len(reply)

    def test_shrinking_edit_allowed(self, client):
        c, server = client
        server._edit_request = lambda text, command: "The fix works."
        resp = c.post(
            "/edit",
            data=json.dumps({
                "text": "The fix works. " * 20,
                "command": "delete everything after the first sentence",
            }),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["text"] == "The fix works."


class TestParseSuggestions:
    def test_parses_clean_json(self, server):
        reply = '[{"wrong": "quad", "right": "Claude"}, {"wrong": "termix", "right": "Termux"}]'
        out = server._parse_suggestions(reply, {})
        assert out == [
            {"wrong": "quad", "right": "Claude"},
            {"wrong": "termix", "right": "Termux"},
        ]

    def test_parses_json_with_surrounding_prose(self, server):
        reply = 'Here you go:\n[{"wrong": "quad", "right": "Claude"}]\nDone.'
        assert server._parse_suggestions(reply, {}) == [{"wrong": "quad", "right": "Claude"}]

    def test_malformed_reply_yields_empty(self, server):
        for reply in ("", "no json here", "[not json", '{"wrong": "a"}', "[1, 2, 3]"):
            assert server._parse_suggestions(reply, {}) == []

    def test_filters_existing_self_maps_and_dupes(self, server):
        reply = json.dumps([
            {"wrong": "quad", "right": "Claude"},
            {"wrong": "Quad", "right": "Claude"},           # dupe (case)
            {"wrong": "known", "right": "fixed"},           # already in dict
            {"wrong": "same", "right": "Same"},             # self-map
            {"wrong": "", "right": "x"},                    # empty
            {"wrong": "w" * 41, "right": "x"},              # too long
            {"wrong": "ok", "right": 7},                    # wrong type
        ])
        out = server._parse_suggestions(reply, {"known": "fixed"})
        assert out == [{"wrong": "quad", "right": "Claude"}]

    def test_caps_at_ten(self, server):
        reply = json.dumps([
            {"wrong": f"w{i}", "right": f"r{i}"} for i in range(20)
        ])
        assert len(server._parse_suggestions(reply, {})) == 10


class TestSuggestEndpoint:
    def test_no_transcripts_short_circuits(self, client):
        c, server = client
        server.recent_transcripts.clear()
        # No LLM needed — even mark it unavailable
        server._is_cleanup_server_alive = lambda: False
        resp = c.post("/corrections/suggest")
        assert resp.status_code == 200
        assert resp.get_json() == {"suggestions": [], "transcripts": 0}

    def test_suggests_from_recent_transcripts(self, client):
        c, server = client
        server.recent_transcripts.clear()
        server._remember_transcript("tell quad to fix the login bug")
        server._remember_transcript("ask quad about the release notes")
        seen = {}

        def fake_suggest(transcripts, existing):
            seen["transcripts"] = transcripts
            seen["existing"] = existing
            return '[{"wrong": "quad", "right": "Claude"}]'

        server._suggest_request = fake_suggest
        resp = c.post("/corrections/suggest")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["suggestions"] == [{"wrong": "quad", "right": "Claude"}]
        assert data["transcripts"] == 2
        assert len(seen["transcripts"]) == 2

    def test_llm_unavailable_503(self, client):
        c, server = client
        server.recent_transcripts.clear()
        server._remember_transcript("a transcript long enough to keep")
        server._is_cleanup_server_alive = lambda: False
        assert c.post("/corrections/suggest").status_code == 503

    def test_request_error_502(self, client):
        c, server = client
        server.recent_transcripts.clear()
        server._remember_transcript("a transcript long enough to keep")

        def boom(transcripts, existing):
            raise OSError("connection refused")

        server._suggest_request = boom
        assert c.post("/corrections/suggest").status_code == 502


class TestRememberTranscript:
    def test_short_and_empty_ignored(self, server):
        server.recent_transcripts.clear()
        server._remember_transcript("")
        server._remember_transcript("hi there")  # < 12 chars
        assert len(server.recent_transcripts) == 0

    def test_keeps_recent_bounded(self, server):
        server.recent_transcripts.clear()
        for i in range(30):
            server._remember_transcript(f"transcript number {i} with enough length")
        assert len(server.recent_transcripts) == 20
        assert "number 29" in server.recent_transcripts[-1]
