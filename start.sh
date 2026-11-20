#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

BIN="./gopostman"
if [ -f "./gopostman.exe" ]; then BIN="./gopostman.exe"; fi
if [ ! -f "$BIN" ]; then
  echo "Building GoPostman..."
  go build -o "$BIN" .
fi

echo "GoPostman -> http://127.0.0.1:8080  (no login required, local data only)"
exec "$BIN" "$@"
