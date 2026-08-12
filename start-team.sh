#!/usr/bin/env bash
# Spawn N decentralized bodies (Unix sockets). No hub, no HTTP ports.
# Usage: ./start-team.sh [count=5]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNT="${1:-5}"
PREFIX="${PLAYER_PREFIX:-Bot}"

if [[ "$COUNT" -gt 20 ]]; then
  echo "[team] WARNING: >20 bots is heavy; continuing anyway"
fi

for i in $(seq 1 "$COUNT"); do
  name="${PREFIX}${i}"
  soul="$ROOT/souls/andy.toml"
  if [[ "$i" -eq 2 && -f "$ROOT/souls/miner.toml" ]]; then
    soul="$ROOT/souls/miner.toml"
  elif [[ "$i" -ge 3 && -f "$ROOT/souls/wild.toml" ]]; then
    soul="$ROOT/souls/wild.toml"
  fi
  echo "[team] spawn $name soul=$(basename "$soul")"
  "$ROOT/start-player.sh" "$name" "$soul" || true
done

echo "[team] done. $COUNT bodies (Unix sockets under run/socks/)."
echo "  ./gbot/gbot list"
echo "  ./gbot/gbot attach ${PREFIX}1"
echo "  ./gbot/gbot cmd ${PREFIX}1 status"
