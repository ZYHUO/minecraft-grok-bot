#!/usr/bin/env bash
# Start Control Hub (single port for all Grok Bots + mail/board).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_DIR="$ROOT/hub"
LOG_DIR="$ROOT/logs"
PID_FILE="$LOG_DIR/hub.pid"
LOG_FILE="$LOG_DIR/hub.log"
export HUB_PORT="${HUB_PORT:-3100}"
export HUB_HOST="${HUB_HOST:-127.0.0.1}"
export HUB_SHARED="${HUB_SHARED:-$ROOT/shared/hub}"

mkdir -p "$LOG_DIR" "$HUB_SHARED/mailbox" "$HUB_SHARED/channels"

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    sleep 0.3
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "[hub] stopped $pid"
  else
    echo "[hub] no pid file"
  fi
  exit 0
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[hub] already running pid=$(cat "$PID_FILE") port=$HUB_PORT"
  exit 0
fi

if [[ ! -d "$HUB_DIR/node_modules" ]]; then
  echo "[hub] npm install..."
  (cd "$HUB_DIR" && npm install --omit=dev)
fi

cd "$HUB_DIR"
nohup node hub.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 0.5
echo "[hub] started pid=$(cat "$PID_FILE")"
echo "  URL:    http://${HUB_HOST}:${HUB_PORT}"
echo "  store:  $HUB_SHARED"
echo "  log:    $LOG_FILE"
echo "  stop:   $0 --stop"
echo "  CLI:    $ROOT/mcctl health"
