#!/usr/bin/env bash
# Runs the backend and a socat shim from 127.0.0.1:$1 to its socket. Ctrl-C stops both.
set -euo pipefail
port="${1:-8081}"
socket=./data/backend.sock
mkdir -p ./data

"${BACKEND:-./data/backend/bin/backend}" serve &
server=$!
shim=""
trap 'kill $server $shim 2>/dev/null || true' EXIT INT TERM
until [ -S "$socket" ]; do
  kill -0 "$server" 2>/dev/null || exit 1
  sleep 0.1
done
socat "TCP-LISTEN:$port,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$socket" &
shim=$!
echo "Open http://localhost:$port — new user: make user NAME=alice"
wait "$server"
