"""The gate and CI both build the PWA with `npm run build`, so that script
must run the PWA's vitest suite first: it is the only place the credits guard
(pwa/src/lib/credits.test.ts) and every other PWA unit test run on a landing.
"""

import json
import os

PWA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "pwa"))


def _scripts():
    with open(os.path.join(PWA_DIR, "package.json")) as f:
        return json.load(f)["scripts"]


def test_build_runs_the_unit_tests_before_building():
    build = _scripts()["build"]
    assert "npm test" in build or "vitest run" in build
    assert build.index("test") < build.index("vite build")


def test_unit_test_script_lists_files_so_the_credits_test_is_named():
    test = _scripts()["test"]
    assert "vitest run" in test
    assert "--reporter=verbose" in test


def test_credits_guard_exists():
    assert os.path.isfile(os.path.join(PWA_DIR, "src", "lib", "credits.test.ts"))
