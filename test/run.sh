#!/bin/sh
# Full test suite, local only (no Cloudflare account): starts the test Worker under wrangler dev
# with fresh state, then runs every Deno test against it and against real Deno KV.
#   sh test/run.sh            (needs deno >= 2.5 on PATH or DENO=/path/to/deno, and `npm ci`)
#   TEST_WORKER_PORT=8800 sh test/run.sh    (the port must be free; a second run needs its own clone and port)
set -eu
cd "$(dirname "$0")/.."
DENO="${DENO:-deno}"
PORT="${TEST_WORKER_PORT:-8799}"
if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "port $PORT already answers (another run?); set TEST_WORKER_PORT to a free port" >&2
  exit 1
fi
STATE="$(pwd)/.wrangler/test-state"
rm -rf "$STATE"
LOG="$(mktemp)"
sh test/worker/serve.sh "$PORT" >"$LOG" 2>&1 &
WORKER=$!
# stop only what this run started: the Worker process and its descendants (wrangler, workerd)
tree() {
  for c in $(pgrep -P "$1"); do tree "$c"; done
  echo "$1"
}
stop() {
  kill -TERM $(tree "$WORKER") 2>/dev/null || true
}
trap stop EXIT INT TERM
i=0
until curl -s -o /dev/null "http://127.0.0.1:$PORT/"; do
  i=$((i + 1))
  if [ "$i" -gt 60 ] || ! kill -0 "$WORKER" 2>/dev/null; then echo "test Worker did not start:"; cat "$LOG"; exit 1; fi
  sleep 1
done
TEST_WORKER_URL="http://127.0.0.1:$PORT" TEST_WORKER_STATE="$STATE" "$DENO" test --unstable-kv -A test/ "$@"
