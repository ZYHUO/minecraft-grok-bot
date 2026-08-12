#!/usr/bin/env bash
# Download Modflared 1.20.1 client jars (Fabric + Forge) for human players.
# Paper cannot load these. Mineflayer bots do not use them.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Fabric 1.20.1 — Modrinth version sdUluPhe
FABRIC_URL="https://cdn.modrinth.com/data/uRHq6kbO/versions/sdUluPhe/modflared-1.2.0%2Brelease.61.jar"
FABRIC_SHA1="8faaad72d9d9096573eeaefb180fb7f34ab851b0"
FABRIC_OUT="modflared-1.20.1-fabric.jar"

# Forge 1.20.1 — Modrinth version 6sx0Vsi0
FORGE_URL="https://cdn.modrinth.com/data/uRHq6kbO/versions/6sx0Vsi0/modflared-1.2.0%2Brelease.61.jar"
FORGE_SHA1="9289085224ee0adec0893fe3b24256c5e9b02550"
FORGE_OUT="modflared-1.20.1-forge.jar"

fetch() {
  local url="$1" out="$2" sha="$3"
  echo "[modflared] $out"
  curl -fsSL -o "$out" "$url"
  local got
  got="$(sha1sum "$out" | awk '{print $1}')"
  if [[ "$got" != "$sha" ]]; then
    echo "[modflared] sha1 mismatch for $out (got $got want $sha)" >&2
    rm -f "$out"
    exit 1
  fi
}

fetch "$FABRIC_URL" "$FABRIC_OUT" "$FABRIC_SHA1"
fetch "$FORGE_URL" "$FORGE_OUT" "$FORGE_SHA1"
echo "[modflared] ok — give the matching jar to players (client mods folder)"
echo "  Fabric: $DIR/$FABRIC_OUT"
echo "  Forge:  $DIR/$FORGE_OUT"
