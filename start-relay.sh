#!/bin/bash
# Start codex-relay (Deno) with configuration file
# Usage:
#   ./start-relay.sh                    # Uses relay-config.json in current directory
#   ./start-relay.sh /path/to/config.json

CONFIG_FILE="${1:-./relay-config.json}"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Config file not found: $CONFIG_FILE"
    echo "Usage: $0 [config-file-path]"
    exit 1
fi

export CODEX_RELAY_PORT=7150
export CODEX_RELAY_CONFIG="$CONFIG_FILE"

echo "============================================="
echo "  Starting codex-relay (Deno)"
echo "============================================="
echo "  port:     $CODEX_RELAY_PORT"
echo "  config:   $CODEX_RELAY_CONFIG"
echo "============================================="
echo ""

exec deno run --allow-net --allow-read --allow-env main.ts