#!/usr/bin/env python3
"""Checks docs/best-practices-audit.md against the story's acceptance criteria.

Run from anywhere:  python3 -I docs/check-best-practices-audit.py

1. the audit exists and has one row for every checklist line (C01..) plus the six
   rules added 2026-10-09 (N01..N06); every row has a status and evidence;
2. every `file:line` the evidence cites exists in this repo;
3. every fail row has a fix and a size; the ranked list has at most 10 stories,
   each with a check that can be run.

The checklist is the vault's seats/builder/pwa-best-practices/checklist.md when
that file is on this host (the count is read from it); otherwise the count the
audit was written against (CHECKLIST_LINES) is used.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIT = os.path.join(ROOT, "docs", "best-practices-audit.md")
VAULT_CHECKLIST = os.path.expanduser(
    "~/millwright-vault/seats/builder/pwa-best-practices/checklist.md"
)
CHECKLIST_LINES = 32
NEW_RULES = 6
STATUSES = {"pass", "fail", "n/a"}
SIZES = {"S", "M", "L"}
MAX_STORIES = 10

errors = []


def fail(msg):
    errors.append(msg)


def expected_checklist_lines():
    if os.path.exists(VAULT_CHECKLIST):
        with open(VAULT_CHECKLIST, encoding="utf-8") as f:
            return sum(1 for line in f if line.startswith("[ ] "))
    return CHECKLIST_LINES


def cells(row):
    return [c.strip() for c in row.strip().strip("|").split("|")]


def main():
    if not os.path.exists(AUDIT):
        print("FAIL: docs/best-practices-audit.md does not exist")
        return 1
    with open(AUDIT, encoding="utf-8") as f:
        text = f.read()

    rows = {}
    for line in text.splitlines():
        m = re.match(r"\|\s*([CN]\d\d)\s*\|", line)
        if m:
            c = cells(line)
            if m.group(1) in rows:
                fail(f"{m.group(1)}: row appears twice")
            rows[m.group(1)] = c

    want_c = expected_checklist_lines()
    got_c = sorted(k for k in rows if k[0] == "C")
    got_n = sorted(k for k in rows if k[0] == "N")
    if got_c != [f"C{i:02d}" for i in range(1, want_c + 1)]:
        fail(f"checklist rows: want C01..C{want_c:02d} ({want_c}), got {len(got_c)}")
    if got_n != [f"N{i:02d}" for i in range(1, NEW_RULES + 1)]:
        fail(f"new-rule rows: want N01..N{NEW_RULES:02d}, got {len(got_n)}")

    # | id | rule | status | evidence | fix | size |
    for rid, c in sorted(rows.items()):
        if len(c) != 6:
            fail(f"{rid}: want 6 columns (id, rule, status, evidence, fix, size), got {len(c)}")
            continue
        _, rule, status, evidence, fix, size = c
        if not rule:
            fail(f"{rid}: no rule text")
        if status not in STATUSES:
            fail(f"{rid}: status {status!r} is not pass, fail or n/a")
        if len(evidence) < 10:
            fail(f"{rid}: no evidence")
        if status == "fail":
            if len(fix) < 10 or fix in {"-", "none"}:
                fail(f"{rid}: fail row has no fix")
            if size not in SIZES:
                fail(f"{rid}: fail row size {size!r} is not S, M or L")

    # every file:line citation exists
    cited = set(re.findall(r"`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`", text))
    if not cited:
        fail("no file:line citations found")
    for path, a, b in sorted(cited):
        full = os.path.join(ROOT, path)
        if not os.path.isfile(full):
            fail(f"cited file does not exist: {path}")
            continue
        with open(full, encoding="utf-8", errors="replace") as f:
            n = sum(1 for _ in f)
        top = int(b) if b else int(a)
        if int(a) < 1 or top > n or (b and int(b) < int(a)):
            fail(f"cited line out of range: {path}:{a}{'-' + b if b else ''} (file has {n} lines)")

    # ranked list
    m = re.search(r"^## Ranked fix stories\s*$(.*?)(?=^## |\Z)", text, re.S | re.M)
    if not m:
        fail("no '## Ranked fix stories' section")
    else:
        items = re.findall(r"^(\d+)\.\s+(.*)$", m.group(1), re.M)
        if not items:
            fail("ranked list is empty")
        if len(items) > MAX_STORIES:
            fail(f"ranked list has {len(items)} items, at most {MAX_STORIES}")
        for n, body in items:
            if "**" not in body:
                fail(f"story {n}: no bold one-line title")
            mm = re.search(r"Check:\s*`([^`]+)`", body)
            if not mm:
                fail(f"story {n}: no runnable check (Check: `command`)")

    if errors:
        for e in errors:
            print("FAIL:", e)
        return 1
    print(
        f"ok: {len(got_c)} checklist rows, {len(got_n)} new-rule rows, "
        f"{len(cited)} citations exist, {len(items)} ranked stories"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
