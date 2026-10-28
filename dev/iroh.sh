#!/usr/bin/env bash
# Exposes the backend's socket over iroh, for the Android app (sashee/iroh-webview-app). The endpoint keeps
# its identity across restarts (./data/iroh-secret), so the endpoint saved in the app keeps working.
set -euo pipefail
bin=./data/iroh-ssh/bin
secret=./data/iroh-secret
if [ ! -s "$secret" ]; then
  (umask 077 && "$bin/iroh-ssh-generate-secret" > "$secret" 2>/dev/null)
fi
IROH_SECRET="$(cat "$secret")" exec "$bin/iroh-uds-listen" ./data/backend.sock
