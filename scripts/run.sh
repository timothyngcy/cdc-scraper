#!/bin/bash
# Wrapper launchd invokes. launchd gives a minimal environment, so resolve node
# explicitly and always run from the project root.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# Make common node installs visible (nvm, homebrew, system).
export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "[$(date)] ERROR: node not found on PATH" >> logs/cdc.log
  exit 1
fi

mkdir -p logs
"$NODE" --env-file-if-exists=.env src/check.mjs --jitter >> logs/cdc.log 2>&1
