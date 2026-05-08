#!/bin/bash
# codex-relay service manager
# Usage: ./relay-service.sh {start|stop|restart|status}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/relay-config.json"
PID_FILE="${SCRIPT_DIR}/.relay.pid"
PORT=7150

start() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "codex-relay is already running (pid: $pid)"
            return 0
        else
            echo "Removing stale pid file"
            rm -f "$PID_FILE"
        fi
    fi

    if ! lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
        :
    else
        echo "Port $PORT is already in use"
        return 1
    fi

    if [ ! -f "$CONFIG_FILE" ]; then
        echo "Config file not found: $CONFIG_FILE"
        return 1
    fi

    echo "Starting codex-relay (Deno)..."

    export CODEX_RELAY_PORT=$PORT
    export CODEX_RELAY_CONFIG="$CONFIG_FILE"

    deno run --allow-net --allow-read --allow-write --allow-env "$SCRIPT_DIR/main.ts" &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
        echo "codex-relay started (pid: $pid, port: $PORT)"
    else
        echo "Failed to start codex-relay"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping codex-relay (pid: $pid)..."
            kill "$pid"
            rm -f "$PID_FILE"
            echo "codex-relay stopped"
        else
            echo "Process $pid not running, removing stale pid file"
            rm -f "$PID_FILE"
        fi
    else
        # Fallback: find by port
        local pid=$(lsof -ti :$PORT 2>/dev/null)
        if [ -n "$pid" ]; then
            echo "Stopping codex-relay (pid: $pid) on port $PORT..."
            kill "$pid"
            echo "codex-relay stopped"
        else
            echo "codex-relay is not running"
        fi
    fi
}

status() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "codex-relay is running (pid: $pid, port: $PORT)"
            return 0
        else
            echo "codex-relay pid file exists but process $pid is not running"
            return 1
        fi
    else
        local pid=$(lsof -ti :$PORT 2>/dev/null)
        if [ -n "$pid" ]; then
            echo "codex-relay is running (pid: $pid, port: $PORT)"
            echo "Warning: no pid file found, process may have been started manually"
            return 0
        else
            echo "codex-relay is not running"
            return 1
        fi
    fi
}

restart() {
    stop
    sleep 1
    start
}

case "$1" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
