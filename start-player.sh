#!/usr/bin/env bash
# Start one decentralized player body (Unix socket control; no hub).
# Usage: ./start-player.sh <name> [soul.toml] [host] [mc_port]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${1:-}"
SOUL="${2:-$ROOT/souls/andy.toml}"
HOST="${3:-127.0.0.1}"
MC_PORT="${4:-25565}"

if [[ -z "$NAME" ]]; then
  echo "Usage: $0 <name> [soul.toml] [host] [mc_port]"
  echo "Example: $0 Andy souls/andy.toml"
  echo "Control: $ROOT/gbot/gbot attach Andy   (or: gbot cmd Andy status)"
  exit 1
fi

if [[ -x "$ROOT/gbot/gbot" ]]; then
  exec "$ROOT/gbot/gbot" spawn -name "$NAME" -soul "$SOUL" -host "$HOST" -mc-port "$MC_PORT"
fi

# fallback without Go binary
SOCK="$ROOT/run/socks/${NAME}.sock"
mkdir -p "$ROOT/run/socks" "$ROOT/logs" "$ROOT/memory"
if [[ ! -d "$ROOT/player-bot/node_modules" ]]; then
  (cd "$ROOT/player-bot" && npm install --omit=dev)
fi
nohup node "$ROOT/player-bot/player-bot.js" \
  --name "$NAME" \
  --socket "$SOCK" \
  --soul "$SOUL" \
  --host "$HOST" \
  --mc-port "$MC_PORT" \
  >> "$ROOT/logs/player-${NAME}.log" 2>&1 &
echo $! > "$ROOT/run/pids/${NAME}.pid"
echo "[player] $NAME socket=$SOCK pid=$(cat "$ROOT/run/pids/${NAME}.pid")"
echo "  gbot cmd $NAME status"
