"""Tests for scripts/requirements.txt and the Termux scripts that use it.

The phone's pip packages used to be a bare `pip install flask` in
setup-termux.sh, so a `pkg upgrade` that replaced Python left the server
without flask and nothing said so. requirements.txt is now the one list,
setup-termux.sh and update-all.sh install from it, and
start-whisper-server.sh refuses to start when a listed module is missing.
"""

import ast
import os
import re
import stat
import subprocess
import sys

import pytest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REQUIREMENTS = os.path.join(SCRIPTS_DIR, "requirements.txt")
SERVER = os.path.join(SCRIPTS_DIR, "whisper-server.py")

# Third-party imports whisper-server.py makes that are NOT pip packages on the
# phone: Termux ships them prebuilt (`pkg install python-numpy
# python-onnxruntime`) because pip cannot build them against Android's libc.
# Today the server has none at top level (they are optional, behind try/except
# in parakeet_onnx.py and the engine loader); list any that appear here.
PKG_PROVIDED = {"numpy", "onnxruntime"}


def _requirement_names():
    names = []
    with open(REQUIREMENTS) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if line:
                names.append(re.split(r"[<>=!~;\[ ]", line, 1)[0].lower())
    return names


def _top_level_imports(path):
    """Top-level module names imported at module level, outside try/except
    and outside functions."""
    with open(path) as f:
        tree = ast.parse(f.read())
    mods = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            mods.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            mods.add(node.module.split(".")[0])
    return mods


def test_requirements_file_names_flask():
    assert os.path.isfile(REQUIREMENTS)
    assert "flask" in _requirement_names()


def test_requirements_says_numpy_and_onnxruntime_come_from_pkg():
    with open(REQUIREMENTS) as f:
        text = f.read()
    assert "pkg" in text
    assert "numpy" in text and "onnxruntime" in text
    # ...and they are comments, not requirements
    assert not {"numpy", "onnxruntime"} & set(_requirement_names())


def test_server_third_party_imports_are_covered():
    required = set(_requirement_names())
    stdlib = set(sys.stdlib_module_names)
    third_party = {m for m in _top_level_imports(SERVER) if m not in stdlib}
    uncovered = {m for m in third_party if m.lower() not in required and m not in PKG_PROVIDED}
    assert not uncovered, (
        f"whisper-server.py imports {sorted(uncovered)} at top level; add them to "
        "scripts/requirements.txt (or to PKG_PROVIDED here if pkg supplies them)"
    )


def _read(name):
    with open(os.path.join(SCRIPTS_DIR, name)) as f:
        return f.read()


def test_setup_termux_installs_from_requirements():
    text = _read("setup-termux.sh")
    assert re.search(r"pip install .*-r .*requirements\.txt", text)
    assert "pip install flask" not in text


def test_update_all_installs_from_requirements():
    text = _read("update-all.sh")
    assert re.search(r"pip install .*-r .*requirements\.txt", text)


def _stub(path, body):
    with open(path, "w") as f:
        f.write("#!/bin/bash\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)


def _run_start(tmp_path, python_body):
    """Run start-whisper-server.sh with stub python3/tmux first on PATH."""
    install = tmp_path / "install"
    install.mkdir()
    (install / "whisper-server.py").write_text("# stub\n")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    calls = tmp_path / "tmux-calls"
    _stub(str(bindir / "python3"), python_body)
    # has-session fails (not running); anything is recorded
    _stub(str(bindir / "tmux"), f'echo "$@" >> "{calls}"\n[ "$1" = has-session ] && exit 1\nexit 0\n')
    env = dict(os.environ)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["WHISPER_INSTALL_DIR"] = str(install)
    result = subprocess.run(
        ["bash", os.path.join(SCRIPTS_DIR, "start-whisper-server.sh")],
        env=env, capture_output=True, text=True, timeout=30,
    )
    return result, calls


def test_start_refuses_when_flask_cannot_be_imported(tmp_path):
    result, calls = _run_start(tmp_path, "exit 1\n")
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert (
        "Missing Python module: flask. Run: pip install -r "
        "~/whisper-hid/scripts/requirements.txt"
    ) in out
    assert not calls.exists(), "tmux must not be called"


def test_start_proceeds_when_modules_import(tmp_path):
    result, calls = _run_start(tmp_path, "exit 0\n")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "new-session" in calls.read_text()


def test_start_names_only_the_module_that_is_missing(tmp_path):
    # python3 -c "import X" fails only for flask
    body = 'case "$*" in *flask*) exit 1;; esac\nexit 0\n'
    result, calls = _run_start(tmp_path, body)
    assert result.returncode == 1
    assert "Missing Python module: flask" in result.stdout + result.stderr
