#!/usr/bin/env python3
"""Launcher: `python3 research/clbot.py AAPL` from anywhere in the repo."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from comment_letter_bot.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
