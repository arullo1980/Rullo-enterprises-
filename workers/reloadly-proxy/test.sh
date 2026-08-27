#!/usr/bin/env bash
# Quick check that the deployed Worker is returning operators.
# Usage:  ./test.sh https://rullo-reloadly-proxy.<you>.workers.dev
set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "Usage: ./test.sh <worker-url>"
  echo "  e.g. ./test.sh https://rullo-reloadly-proxy.yourname.workers.dev"
  exit 1
fi
BASE="${BASE%/}"

pp() { if command -v python3 >/dev/null 2>&1; then python3 -m json.tool 2>/dev/null || cat; else cat; fi; }

echo "→ GET $BASE/health"
curl -fsS "$BASE/health" | pp
echo

echo "→ GET $BASE/operators?country=NG   (Nigeria)"
curl -fsS "$BASE/operators?country=NG" | pp | head -40
echo

echo "→ GET $BASE/operators?country=MX   (Mexico)"
curl -fsS "$BASE/operators?country=MX" | pp | head -20
echo

echo "→ GET $BASE/operators?country=ZZ   (invalid — expect a 400 error)"
curl -sS "$BASE/operators?country=ZZ" | pp
echo
echo "If /health is ok and NG/MX return operator lists, the pipe works —"
echo "send me the Worker URL and I'll wire it into the coverage explorer."
