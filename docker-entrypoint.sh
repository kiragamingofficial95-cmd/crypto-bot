#!/bin/sh
# Railway mounts volumes owned by root, so the directory has to be prepared
# before the process drops privileges. If the chown is not possible we stay
# as root rather than failing to write state.
set -e

DATA_DIR="${DATA_DIR:-/data}"
LOG_DIR="${LOG_DIR:-/logs}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$LOG_DIR" 2>/dev/null || true
  chown -R node:node "$DATA_DIR" "$LOG_DIR" 2>/dev/null || true

  if command -v su-exec >/dev/null 2>&1 && [ -d "$DATA_DIR" ]; then
    # Only drop privileges if we can actually write where we need to.
    if [ -w "$DATA_DIR" ] && [ -w "$LOG_DIR" ]; then
      exec su-exec node "$@"
    fi
  fi
fi

exec "$@"
