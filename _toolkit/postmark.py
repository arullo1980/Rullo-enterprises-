#!/usr/bin/env python3
"""Postmark - cross-machine work protocol for shared repositories.

Two rules this enforces:
  1. GitHub is the master at the start of every work session.
  2. Every machine leaves a dated postmark in README.md when it finishes,
     so no machine ever silently undoes another machine's work.

Usage:
    python postmark.py check                      # start of session
    python postmark.py stamp -m "what I changed"  # end of session
    python postmark.py init                       # add the block to a README

Machine identity comes from $POSTMARK_MACHINE, falling back to the hostname.
Standard library only - runs anywhere Python 3.8+ does.
"""

import argparse
import datetime
import os
import socket
import subprocess
import sys

BEGIN = "<!-- POSTMARK:BEGIN -->"
END = "<!-- POSTMARK:END -->"

HEADER = [
    "## Work Postmark",
    "",
    "_Maintained by `_toolkit/postmark.py`. Each machine stamps its row when it",
    "finishes a session. Do not edit by hand; never delete another machine row._",
    "",
    "| Machine | Last touched (UTC) | Branch | Commit | Summary |",
    "| ------- | ------------------ | ------ | ------ | ------- |",
]


def machine_name():
    return os.environ.get("POSTMARK_MACHINE") or socket.gethostname()


def git(*args, cwd=None, check=True):
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), proc.stderr.strip()))
    return proc.stdout.strip()


def repo_root(start):
    return git("rev-parse", "--show-toplevel", cwd=start)


def readme_path(root):
    for name in ("README.md", "readme.md", "README.MD"):
        candidate = os.path.join(root, name)
        if os.path.exists(candidate):
            return candidate
    return os.path.join(root, "README.md")


def read_block(text):
    """Return (rows, start_index, end_index) for the postmark block."""
    if BEGIN not in text or END not in text:
        return [], -1, -1
    start = text.index(BEGIN)
    end = text.index(END) + len(END)
    body = text[start:end]
    rows = []
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 5:
            continue
        if cells[0].lower() == "machine" or set(cells[0]) <= {"-", " "}:
            continue
        rows.append(cells[:5])
    return rows, start, end


def render_block(rows):
    lines = [BEGIN, ""] + HEADER
    for row in sorted(rows, key=lambda r: r[1], reverse=True):
        lines.append("| " + " | ".join(row) + " |")
    lines += ["", END]
    return "\n".join(lines)


def cmd_init(args):
    root = repo_root(args.path)
    path = readme_path(root)
    text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    rows, start, _ = read_block(text)
    if start != -1:
        print("Postmark block already present in %s" % os.path.basename(path))
        return 0
    sep = "" if text.endswith("\n") or not text else "\n"
    new = text + sep + "\n---\n\n" + render_block([]) + "\n"
    open(path, "w", encoding="utf-8", newline="\n").write(new)
    print("Added postmark block to %s" % path)
    return 0


def cmd_check(args):
    root = repo_root(args.path)
    name = machine_name()
    label = os.path.basename(root)
    print("=" * 64)
    print("  %s   (machine: %s)" % (label, name))
    print("=" * 64)

    try:
        git("fetch", "origin", "--quiet", cwd=root)
    except RuntimeError as exc:
        print("  ! could not reach origin: %s" % exc)

    has_commits = git("rev-parse", "--verify", "HEAD", cwd=root, check=False)
    if not has_commits:
        print("  branch      : (no commits yet)")
        print("-" * 64)
        print("  VERDICT: NOT SAFE TO WORK")
        print("    - this clone has no commits - the remote may use a different")
        print("      default branch. Run: git -C \"%s\" branch -r" % root)
        return 1

    branch = git("rev-parse", "--abbrev-ref", "HEAD", cwd=root)
    dirty = git("status", "--porcelain", cwd=root)
    upstream = git(
        "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
        cwd=root, check=False,
    )

    behind = ahead = "0"
    if upstream:
        counts = git(
            "rev-list", "--left-right", "--count", "%s...HEAD" % upstream,
            cwd=root, check=False,
        )
        if counts:
            parts = counts.split()
            if len(parts) == 2:
                behind, ahead = parts

    print("  branch      : %s" % branch)
    print("  tracking    : %s" % (upstream or "(none - branch not pushed)"))
    print("  ahead       : %s commit(s)" % ahead)
    print("  behind      : %s commit(s)" % behind)
    print("  local edits : %s" % ("YES - uncommitted changes" if dirty else "none"))

    path = readme_path(root)
    text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    rows, start, _ = read_block(text)
    if start == -1:
        print("  postmark    : NOT SET UP - run 'postmark.py init'")
    else:
        print("  postmark    :")
        if not rows:
            print("      (no machine has stamped this repo yet)")
        for row in sorted(rows, key=lambda r: r[1], reverse=True):
            mine = "  <-- this machine" if row[0] == name else ""
            print("      %-12s %s  [%s]%s" % (row[0], row[1], row[2], mine))
        others = [r for r in rows if r[0] != name]
        if others:
            latest = max(others, key=lambda r: r[1])
            print("      last touched by %s on %s: %s"
                  % (latest[0], latest[1], latest[4]))

    print("-" * 64)
    problems = []
    if behind != "0":
        problems.append("BEHIND origin by %s commit(s) - pull before working" % behind)
    if dirty:
        problems.append("uncommitted local changes - commit or stash first")
    if not upstream:
        problems.append("branch has no upstream - push it before working")

    if problems:
        print("  VERDICT: NOT SAFE TO WORK")
        for problem in problems:
            print("    - %s" % problem)
        if behind != "0":
            print('  Fix: git -C "%s" pull --rebase' % root)
        return 1

    print("  VERDICT: SAFE TO WORK - local matches GitHub")
    return 0


def cmd_stamp(args):
    root = repo_root(args.path)
    name = machine_name()
    path = readme_path(root)

    branch = git("rev-parse", "--abbrev-ref", "HEAD", cwd=root)
    commit = git("rev-parse", "--short", "HEAD", cwd=root, check=False) or "-"
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")
    summary = args.message.replace("|", "/").strip() or "(no summary)"

    text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    rows, start, end = read_block(text)
    if start == -1:
        cmd_init(args)
        text = open(path, encoding="utf-8").read()
        rows, start, end = read_block(text)

    rows = [row for row in rows if row[0] != name]
    rows.append([name, stamp, branch, commit, summary])

    new = text[:start] + render_block(rows) + text[end:]
    open(path, "w", encoding="utf-8", newline="\n").write(new)
    print("Postmarked %s: %s @ %s UTC [%s]" % (os.path.basename(root), name, stamp, branch))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", default=".", help="repo path (default: cwd)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check", help="verify local matches GitHub before working")
    sub.add_parser("init", help="add the postmark block to README.md")
    stamp = sub.add_parser("stamp", help="record this machine session")
    stamp.add_argument("-m", "--message", required=True, help="what changed")

    args = parser.parse_args()
    handlers = {"check": cmd_check, "init": cmd_init, "stamp": cmd_stamp}
    try:
        return handlers[args.cmd](args)
    except RuntimeError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
