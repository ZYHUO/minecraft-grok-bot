#!/usr/bin/env bash
# Download Paper (default 1.20.4, latest stable build) via Paper fill API v3.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION="${PAPER_VERSION:-1.20.4}"
API="https://fill.papermc.io/v3/projects/paper"

echo "[paper] Resolving latest build for $VERSION ..."
BUILD_JSON="$(curl -fsSL "$API/versions/$VERSION/builds")"
DOWNLOAD_URL="$(echo "$BUILD_JSON" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    const builds=JSON.parse(d);
    if(!Array.isArray(builds)||!builds.length){ console.error('no builds'); process.exit(1); }
    // builds are newest-first
    const b=builds[0];
    const dl=b.downloads && (b.downloads['server:default'] || b.downloads.application);
    if(!dl||!dl.url){ console.error('no download url'); process.exit(1); }
    console.error('[paper] build='+b.id+' name='+dl.name);
    console.log(dl.url);
  });
")"

echo "[paper] Downloading ..."
curl -fL --progress-bar -o "paper.jar" "$DOWNLOAD_URL"
echo "[paper] Saved as $SCRIPT_DIR/paper.jar"
ls -lh paper.jar
