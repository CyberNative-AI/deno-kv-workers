#!/bin/sh
# Full test suite, local only (no Cloudflare account): starts the test Worker under wrangler dev
# with fresh state, then runs every Deno test against it and against real Deno KV.
#   sh test/run.sh            (needs deno >= 2.5 on PATH or DENO=/path/to/deno, and `npm ci`)
set -eu
cd "$(dirname "$0")/.."
DENO="${DENO:-deno}"
PORT="${TEST_WORKER_PORT:-8799}"
STATE="$(pwd)/.wrangler/test-state"
rm -rf "$STATE"
LOG="$(mktemp)"
sh test/worker/serve.sh "$PORT" >"$LOG" 2>&1 &
stop() {
  pkill -f "dev --port $PORT --ip 127.0.0.1" 2>/dev/null || true
  pkill -f "socket-addr=entry=127.0.0.1:$PORT " 2>/dev/null || true
}
trap stop EXIT INT TERM
i=0
until curl -s -o /dev/null "http://127.0.0.1:$PORT/"; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "test Worker did not start:"; cat "$LOG"; exit 1; fi
  sleep 1
done
TEST_WORKER_URL="http://127.0.0.1:$PORT" TEST_WORKER_STATE="$STATE" "$DENO" test --unstable-kv -A test/ "$@"
