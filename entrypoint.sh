#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

# ── Ensure data directory exists ─────────────────────────────────────────────
mkdir -p "$DATA_DIR"

# ── Initialise config on the persistent volume (first run only) ───────────────
if [ ! -d "$DATA_DIR/config" ]; then
  echo "[ENTRYPOINT] First run — copying default config to $DATA_DIR/config"
  cp -r /app/config.defaults "$DATA_DIR/config"
fi

# ── Symlink /app/config → volume ──────────────────────────────────────────────
if [ -d /app/config ] && [ ! -L /app/config ]; then
  rm -rf /app/config
fi
if [ ! -L /app/config ]; then
  ln -sf "$DATA_DIR/config" /app/config
  echo "[ENTRYPOINT] Linked /app/config -> $DATA_DIR/config"
fi

# ── Initialise images on the persistent volume (first run only) ──────────────
if [ ! -d "$DATA_DIR/images" ]; then
  echo "[ENTRYPOINT] First run — copying default images to $DATA_DIR/images"
  cp -r /app/images.defaults "$DATA_DIR/images"
fi

# ── Symlink /app/images → volume ────────────────────────────────────────────
if [ -d /app/images ] && [ ! -L /app/images ]; then
  rm -rf /app/images
fi
if [ ! -L /app/images ]; then
  ln -sf "$DATA_DIR/images" /app/images
  echo "[ENTRYPOINT] Linked /app/images -> $DATA_DIR/images"
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
