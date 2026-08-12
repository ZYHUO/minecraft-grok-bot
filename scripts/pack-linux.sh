#!/usr/bin/env bash
# Build a single-file Linux gbot that embeds player-bot + Node 22 + souls.
# Usage: ./scripts/pack-linux.sh [amd64|arm64|all]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO="${GO:-/usr/local/go/bin/go}"
NODE_VER="${NODE_VER:-22.14.0}"
VERSION="${VERSION:-0.2.3}"
ARCHS="${1:-amd64}"
if [[ "$ARCHS" == "all" ]]; then
  ARCHS="amd64 arm64"
fi

export KEEP_MC="1.16 1.16.1 1.17 1.20 1.20.1 1.20.2 1.20.3 1.20.4 common"

need_cmd() { command -v "$1" >/dev/null || { echo "need $1" >&2; exit 1; }; }
need_cmd curl
need_cmd tar
need_cmd gzip
need_cmd python3
[[ -x "$GO" ]] || GO="$(command -v go)"

stage_tree() {
  local arch="$1" stage="$2" node_arch="$3"
  rm -rf "$stage"
  mkdir -p "$stage/player-bot" "$stage/souls" "$stage/bin"

  cp "$ROOT"/player-bot/*.js "$stage/player-bot/"
  cp "$ROOT/player-bot/package.json" "$stage/player-bot/"
  if [[ ! -d "$ROOT/player-bot/node_modules" ]]; then
    (cd "$ROOT/player-bot" && npm install --omit=dev)
  fi
  rsync -a --delete \
    --exclude '.bin' \
    --exclude '**/README*' \
    --exclude '**/*.md' \
    --exclude '**/test' \
    --exclude '**/tests' \
    --exclude '**/*.ts' \
    --exclude '**/*.map' \
    "$ROOT/player-bot/node_modules/" "$stage/player-bot/node_modules/"

  local mcd="$stage/player-bot/node_modules/minecraft-data/minecraft-data/data"
  if [[ -d "$mcd/bedrock" ]]; then
    # index.js always requires bedrock/common/*.json; drop version trees only
    find "$mcd/bedrock" -mindepth 1 -maxdepth 1 -type d ! -name common -exec rm -rf {} +
  fi
  if [[ -d "$mcd/pc" ]]; then
    python3 - "$mcd/pc" <<'PY'
import os, shutil, sys
keep = set(os.environ["KEEP_MC"].split())
root = sys.argv[1]
for name in os.listdir(root):
    if name not in keep:
        p = os.path.join(root, name)
        if os.path.isdir(p):
            shutil.rmtree(p)
PY
  fi

  cp "$ROOT"/souls/*.toml "$stage/souls/"
  echo "$VERSION" > "$stage/VERSION"

  local tarball="node-v${NODE_VER}-linux-${node_arch}.tar.xz"
  local cache="$ROOT/.cache/node"
  mkdir -p "$cache"
  if [[ ! -f "$cache/$tarball" ]]; then
    echo "[pack] download $tarball"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/${tarball}" -o "$cache/$tarball"
  fi
  tar -xJf "$cache/$tarball" -C "$cache" "node-v${NODE_VER}-linux-${node_arch}/bin/node"
  cp "$cache/node-v${NODE_VER}-linux-${node_arch}/bin/node" "$stage/bin/node"
  chmod +x "$stage/bin/node"

  echo "[pack] $arch tree $(du -sh "$stage" | awk '{print $1}')"
}

DIST="$ROOT/dist"
mkdir -p "$DIST"

for arch in $ARCHS; do
  case "$arch" in
    amd64) node_arch=x64 ;;
    arm64) node_arch=arm64 ;;
    *) echo "unknown arch $arch" >&2; exit 1 ;;
  esac
  stage="$ROOT/.cache/bundle-$arch"
  echo "[pack] stage linux/$arch"
  stage_tree "$arch" "$stage" "$node_arch"
  bundle="$ROOT/gbot/bundle.tar.gz"
  echo "[pack] tar $bundle"
  tar -C "$stage" -czhf "$bundle" .
  ls -lh "$bundle"
  echo "[pack] go build -tags pack"
  (cd "$ROOT/gbot" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" "$GO" build -tags pack -trimpath -ldflags="-s -w -X main.packVersion=${VERSION}" -o "$DIST/minecraft-grok-bot-linux-${arch}" .)
  ls -lh "$DIST/minecraft-grok-bot-linux-${arch}"
done

# slim CLI without player-bot (repo users)
for arch in $ARCHS; do
  (cd "$ROOT/gbot" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" "$GO" build -trimpath -ldflags='-s -w' -o "$DIST/gbot-linux-${arch}" .)
done

cd "$DIST"
sha256sum minecraft-grok-bot-linux-* gbot-linux-* > SHA256SUMS
echo "[pack] done"
cat SHA256SUMS
