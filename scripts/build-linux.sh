#!/usr/bin/env bash
# Builds the Linux installers (.deb, .rpm, .AppImage) for x86-64 inside Docker,
# so they can be made from macOS or Windows. Output: release/linux/
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p release/linux
docker run --rm --platform linux/amd64 \
  -v "$PWD":/src:ro \
  -v "$PWD/release/linux":/out \
  -v phantom-linux-cargo:/root/.cargo/registry \
  -v phantom-linux-target:/work/src-tauri/target \
  ubuntu:22.04 bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates git build-essential pkg-config file rsync cmake clang libclang-dev \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev libxdo-dev libxkbcommon-dev libssl-dev >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
    [ -x /root/.cargo/bin/cargo ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
    export PATH=/root/.cargo/bin:$PATH
    rsync -a --exclude node_modules --exclude src-tauri/target --exclude dist --exclude release /src/ /work/
    cd /work
    npm ci --no-audit --no-fund
    CI=true NO_STRIP=true npx tauri build --bundles deb,rpm,appimage
    cp src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/rpm/*.rpm src-tauri/target/release/bundle/appimage/*.AppImage /out/
  '
ls -la release/linux
