#!/usr/bin/env bash
# Smoke-test a DEPLOYED Worker end to end.
#
# For the offline test suite (no deploy, no credentials, no network) run:
#   npm test
#
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

hit() {
  echo "→ GET $BASE$1"
  curl -fsS "$BASE$1" | pp | head -"${2:-20}"
  echo
}

echo "=== health ==="
# Reports the mode (mock/sandbox/live) and whether credentials are configured.
hit "/health"

echo "=== catalog, per country ==="
hit "/coverage?country=NG" 40   # everything Nigeria can receive, in one call
hit "/operators?country=NG" 30  # mobile airtime + data
hit "/giftcards?country=MX" 25  # gift card brands
hit "/utilities?country=NG" 25  # electricity / water / TV billers

echo "=== destinations ==="
hit "/countries" 15

echo "=== input validation (expect a 400) ==="
curl -sS "$BASE/operators?country=ZZZ" | pp
echo

echo "=== CORS (an unlisted origin must NOT be echoed back) ==="
if curl -sSI -H "Origin: https://attacker.example" "$BASE/health" \
     | grep -qi "access-control-allow-origin"; then
  echo "FAIL — the Worker allowed an untrusted origin"
  exit 1
fi
echo "ok — untrusted origin refused"
echo

echo "All checks passed."
echo "Now put the Worker URL into site/js/config.js (apiBase) and push —"
echo "the coverage explorer will start showing real operators per country."
