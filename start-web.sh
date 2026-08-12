#!/usr/bin/env bash
# Start the read-only status website + Mineflayer watcher (no hub required).
# Usage:
#   ./start-web.sh              # background
#   ./start-web.sh --fg         # foreground
#   ./start-web.sh --stop
#   ./start-web.sh --status
#
# Env:
#   MC_HOST MC_PORT MC_VERSION WEB_BOT_NAME WEB_BIND WEB_PORT
# Defaults match Paper in this repo: 127.0.0.1:25565, site on 127.0.0.1:3200
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$ROOT/web"
LOG_DIR="$ROOT/logs"
PID_FILE="$LOG_DIR/web-status.pid"
LOG_FILE="$LOG_DIR/web-status.log"

mkdir -p "$LOG_DIR" "$ROOT/shared/web" "$ROOT/run/pids"

is_pid_alive() {
  local p="${1:-}"
  [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null
}

cmd_stop() {
  local p=""
  if [[ -f "$PID_FILE" ]]; then
    p="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  if is_pid_alive "$p"; then
    echo "[web] Stopping pid=$p ..."
    kill "$p" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8; do
      is_pid_alive "$p" || break
      sleep 0.25
    done
    if is_pid_alive "$p"; then
      kill -9 "$p" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
  echo "[web] Stopped."
}

cmd_status() {
  local p
  p="$(cat "$PID_FILE" 2>/dev/null || true)"
  echo "pid=${p:-none} alive=$(is_pid_alive "${p:-}" && echo yes || echo no)"
  if is_pid_alive "${p:-}"; then
    curl -sS "http://${WEB_BIND:-127.0.0.1}:${WEB_PORT:-3200}/api/status" 2>/dev/null || echo "(HTTP not responding)"
  fi
}

if [[ "${1:-}" == "--stop" ]]; then
  cmd_stop
  exit 0
fi
if [[ "${1:-}" == "--status" ]]; then
  cmd_status
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[web] ERROR: node not found (need Node 20+)"
  exit 1
fi

if [[ ! -d "$WEB_DIR/node_modules" ]]; then
  echo "[web] npm install ..."
  (cd "$WEB_DIR" && npm install --omit=dev)
fi

if [[ -f "$PID_FILE" ]]; then
  OLD="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_pid_alive "$OLD"; then
    echo "[web] Already running (pid $OLD). Stop with: $0 --stop"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

export MC_HOST="${MC_HOST:-127.0.0.1}"
export MC_PORT="${MC_PORT:-25565}"
export WEB_BIND="${WEB_BIND:-127.0.0.1}"
export WEB_PORT="${WEB_PORT:-3200}"
export WEB_BOT_NAME="${WEB_BOT_NAME:-WebWatcher}"

run_cmd=(node "$WEB_DIR/server.js" --host "$MC_HOST" --mc-port "$MC_PORT" --bind "$WEB_BIND" --port "$WEB_PORT" --name "$WEB_BOT_NAME")

if [[ "${1:-}" == "--fg" ]]; then
  echo "[web] Foreground → http://${WEB_BIND}:${WEB_PORT}"
  exec "${run_cmd[@]}"
fi

nohup "${run_cmd[@]}" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "[web] Started in background"
echo "  pid:     $(cat "$PID_FILE")"
echo "  site:    http://${WEB_BIND}:${WEB_PORT}"
echo "  watcher: ${WEB_BOT_NAME} → ${MC_HOST}:${MC_PORT}"
echo "  log:     $LOG_FILE"
echo "  stop:    $0 --stop"
echo "  status:  $0 --status"
echo ""
echo "Smoke test (Paper + at least one player/bot online):"
echo "  curl -s http://${WEB_BIND}:${WEB_PORT}/api/status | jq ."
echo "  open http://${WEB_BIND}:${WEB_PORT}  # count + live chat"
