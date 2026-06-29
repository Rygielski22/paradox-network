#!/usr/bin/env bash
# Paradox Network — VPS one-shot install/start
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
PORT="${PARADOX_PORT:-19132}"

echo "=============================================="
echo " Paradox Network deploy (dir: $ROOT)"
echo "=============================================="

if [ ! -f package.json ]; then
  echo "ERROR: package.json missing — upload full source, not just proxy.js"
  exit 1
fi

if [ -d .git ]; then
  echo "[0/5] Pulling latest code..."
  if ! git pull --ff-only origin main 2>/dev/null; then
    echo "  pull blocked by local pack build files — resetting to origin/main..."
    git checkout -- .pack-ids.json .pack-version resource_pack/manifest.json resource_pack/ui/hud_screen.json 2>/dev/null || true
    git reset --hard origin/main
  fi
fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "  Created config.json from config.example.json"
fi

echo "[1/5] Installing build tools (if needed)..."
apt-get update -qq
apt-get install -y cmake build-essential python3 make g++ >/dev/null 2>&1 || true

echo "[2/5] Installing npm dependencies..."
rm -rf node_modules
npm install --no-audit --no-fund

echo "[3/5] Verifying native + protocol install..."
test -d node_modules/bedrock-protocol || { echo "bedrock-protocol missing after npm install"; exit 1; }
find node_modules/raknet-native -name 'node-raknet.node' | grep -q . || { echo "raknet-native .node binary missing"; exit 1; }

echo "[4/5] Building resource pack (if needed)..."
if [ ! -f paradox_pack.zip ]; then
  npm run build-pack || echo "  (pack build failed — add paradox_pack.zip manually)"
fi

echo "[5/5] Starting pm2..."
pm2 delete paradox-proxy >/dev/null 2>&1 || true
fuser -k "${PORT}/udp" >/dev/null 2>&1 || true
sleep 1
pm2 start proxy.js --name paradox-proxy
pm2 save

echo "=============================================="
ss -ulnp | grep "${PORT}" || echo "  Port $PORT not bound — check: pm2 logs paradox-proxy"
pm2 list
echo "=============================================="