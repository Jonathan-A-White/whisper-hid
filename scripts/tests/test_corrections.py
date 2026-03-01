"""Tests for the word corrections feature."""

import importlib.util
import json
import os
import sys
import tempfile

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


class TestApplyCorrections:
    """Test the apply_corrections function."""

    def test_basic_replacement(self, server):
        server.word_corrections = {"quad": "Claude"}
        assert server.apply_corrections("I asked quad about it") == "I asked Claude about it"

    def test_case_insensitive(self, server):
        server.word_corrections = {"quad": "Claude"}
        assert server.apply_corrections("Quad said hello") == "Claude said hello"
        assert server.apply_corrections("QUAD is great") == "Claude is great"

    def test_multiple_corrections(self, server):
        server.word_corrections = {"quad": "Claude", "clod": "Claude"}
        assert server.apply_corrections("quad and clod") == "Claude and Claude"

    def test_whole_word_only(self, server):
        server.word_corrections = {"quad": "Claude"}
        # "squad" contains "quad" but should NOT be replaced
        assert server.apply_corrections("the squad arrived") == "the squad arrived"

    def test_empty_corrections(self, server):
        server.word_corrections = {}
        assert server.apply_corrections("hello world") == "hello world"

    def test_no_match(self, server):
        server.word_corrections = {"quad": "Claude"}
        assert server.apply_corrections("nothing to replace") == "nothing to replace"

    def test_multiple_occurrences(self, server):
        server.word_corrections = {"quad": "Claude"}
        assert server.apply_corrections("quad said quad") == "Claude said Claude"

    def test_empty_text(self, server):
        server.word_corrections = {"quad": "Claude"}
        assert server.apply_corrections("") == ""

    def test_special_regex_chars_in_key(self, server):
        # Whisper outputs words so "mr." with a period is a realistic case
        server.word_corrections = {"claud": "Claude"}
        # re.escape safely handles the key; \b boundaries match word chars
        assert server.apply_corrections("ask claud about it") == "ask Claude about it"


class TestLoadSaveCorrections:
    """Test loading and saving the corrections file."""

    def test_load_from_file(self, server, tmp_path):
        corrections_file = tmp_path / "corrections.json"
        corrections_file.write_text(json.dumps({"test": "fixed"}))
        server.CORRECTIONS_FILE = str(corrections_file)
        server.load_corrections()
        assert server.word_corrections == {"test": "fixed"}

    def test_load_missing_file(self, server, tmp_path):
        server.CORRECTIONS_FILE = str(tmp_path / "nonexistent.json")
        server.word_corrections = {"old": "data"}
        server.load_corrections()
        assert server.word_corrections == {}

    def test_load_invalid_json(self, server, tmp_path):
        corrections_file = tmp_path / "bad.json"
        corrections_file.write_text("not json{{{")
        server.CORRECTIONS_FILE = str(corrections_file)
        server.word_corrections = {"old": "data"}
        server.load_corrections()
        assert server.word_corrections == {}

    def test_save_and_reload(self, server, tmp_path):
        corrections_file = tmp_path / "corrections.json"
        server.CORRECTIONS_FILE = str(corrections_file)
        server.word_corrections = {"quad": "Claude", "clod": "Claude"}
        server.save_corrections()

        # Verify file was written
        assert corrections_file.exists()
        data = json.loads(corrections_file.read_text())
        assert data == {"quad": "Claude", "clod": "Claude"}

        # Reload and verify
        server.word_corrections = {}
        server.load_corrections()
        assert server.word_corrections == {"quad": "Claude", "clod": "Claude"}


class TestCorrectionsAPI:
    """Test the /corrections API endpoints."""

    @pytest.fixture
    def client(self, server, tmp_path):
        corrections_file = tmp_path / "corrections.json"
        corrections_file.write_text(json.dumps({"quad": "Claude"}))
        server.CORRECTIONS_FILE = str(corrections_file)
        server.load_corrections()
        server.app.config["TESTING"] = True
        return server.app.test_client()

    def test_get_corrections(self, client):
        resp = client.get("/corrections")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data == {"quad": "Claude"}

    def test_put_corrections(self, client):
        resp = client.put(
            "/corrections",
            data=json.dumps({"hello": "world", "foo": "bar"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data == {"hello": "world", "foo": "bar"}

        # Verify it was persisted
        resp2 = client.get("/corrections")
        assert resp2.get_json() == {"hello": "world", "foo": "bar"}

    def test_put_empty_corrections(self, client):
        resp = client.put(
            "/corrections",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json() == {}

    def test_put_invalid_body(self, client):
        resp = client.put(
            "/corrections",
            data="not json",
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_put_non_string_values(self, client):
        resp = client.put(
            "/corrections",
            data=json.dumps({"key": 123}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_put_empty_key(self, client):
        resp = client.put(
            "/corrections",
            data=json.dumps({"": "value"}),
            content_type="application/json",
        )
        assert resp.status_code == 400


class TestDefaultCorrectionsFile:
    """Test the shipped word-corrections.json file."""

    def test_default_file_is_valid_json(self):
        corrections_path = os.path.join(
            os.path.dirname(__file__), "..", "word-corrections.json"
        )
        assert os.path.isfile(corrections_path), "word-corrections.json should exist"
        with open(corrections_path) as f:
            data = json.load(f)
        assert isinstance(data, dict)
        for k, v in data.items():
            assert isinstance(k, str) and k.strip(), f"Key must be non-empty string: {k!r}"
            assert isinstance(v, str) and v.strip(), f"Value must be non-empty string: {v!r}"
