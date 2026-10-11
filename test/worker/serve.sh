#!/bin/sh
# Start the test Worker locally (no Cloudflare account): sh test/worker/serve.sh [port]
cd "$(dirname "$0")" && exec ../../node_modules/.bin/wrangler dev --port "${1:-8799}" --ip 127.0.0.1 --persist-to ../../.wrangler/test-state --show-interactive-dev-session=false
