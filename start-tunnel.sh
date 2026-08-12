#!/usr/bin/env bash
# Cloudflare Tunnel in front of Paper (127.0.0.1:25565).
# Human clients use the Modflared Fabric/Forge mod. Local gbot bodies do not.
#
#   ./start-tunnel.sh           # background
#   ./start-tunnel.sh --fg
#   ./start-tunnel.sh --stop
#   ./start-tunnel.sh --status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
PID_FILE="$LOG_DIR/cloudflared.pid"
LOG_FILE="$LOG_DIR/cloudflared.log"
CFG="$ROOT/server/cloudflared/config.yml"

mkdir -p "$LOG_DIR"

is_alive() {
  local p="${1:-}"
  [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null
}

cmd="${1:-}"
if [[ "$cmd" == "--stop" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_alive "$pid"; then
      kill "$pid" 2>/dev/null || true
      echo "[tunnel] stopped pid=$pid"
    fi
    rm -f "$PID_FILE"
  fi
  exit 0
fi

if [[ "$cmd" == "--status" ]]; then
  if [[ -f "$PID_FILE" ]] && is_alive "$(cat "$PID_FILE")"; then
    echo "[tunnel] running pid=$(cat "$PID_FILE")"
  else
    echo "[tunnel] not running"
  fi
  exit 0
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[tunnel] cloudflared not in PATH" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]] && is_alive "$(cat "$PID_FILE")"; then
  echo "[tunnel] already running pid=$(cat "$PID_FILE")"
  exit 0
fi

args=()
if [[ -n "${CLOUDFLARED_TOKEN:-}" ]]; then
  args=(tunnel --no-autoupdate run --token "$CLOUDFLARED_TOKEN")
elif [[ -f "$CFG" ]]; then
  args=(tunnel --no-autoupdate --config "$CFG" run)
else
  echo "[tunnel] set CLOUDFLARED_TOKEN or copy server/cloudflared/config.yml.example → config.yml" >&2
  exit 1
fi

if [[ "$cmd" == "--fg" ]]; then
  exec cloudflared "${args[@]}"
fi

nohup cloudflared "${args[@]}" >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
echo "[tunnel] started pid=$(cat "$PID_FILE") log=$LOG_FILE"
echo "[tunnel] local bots still use 127.0.0.1:25565; players with Modflared use the hostname"
