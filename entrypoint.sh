#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

# ── Ensure data directory exists ─────────────────────────────────────────────
mkdir -p "$DATA_DIR"

# ── Initialise config on the persistent volume (first run only) ───────────────
# /app/config.defaults contains the bundled defaults baked into the image.
# On first run we copy them to the volume so they survive restarts.
if [ ! -d "$DATA_DIR/config" ]; then
  echo "[ENTRYPOINT] First run — copying default config to $DATA_DIR/config"
  cp -r /app/config.defaults "$DATA_DIR/config"
fi

# ── Symlink /app/config → volume ─────────────────────────────────────────────
# This lets all existing code keep using path.join(__dirname, '..', 'config', …)
# while the real data lives on the Railway volume.
if [ -d /app/config ] && [ ! -L /app/config ]; then
  rm -rf /app/config
fi
if [ ! -L /app/config ]; then
  ln -sf "$DATA_DIR/config" /app/config
  echo "[ENTRYPOINT] Linked /app/config -> $DATA_DIR/config"
fi

# ── Clear stale Chromium lock files left by previous containers ─────────────
# Each service may use a different CLIENT_ID, but we wipe all singleton locks
# under .wwebjs_auth regardless, since only one session runs per container.
if [ -d "$DATA_DIR/.wwebjs_auth" ]; then
  find "$DATA_DIR/.wwebjs_auth" \
    \( -name 'SingletonLock' -o -name 'SingletonCookie' -o -name 'SingletonSocket' \) \
    -delete 2>/dev/null || true
  echo "[ENTRYPOINT] Cleared stale Chromium lock files"
fi

exec node src/index.js
