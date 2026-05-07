#!/usr/bin/env bash
# Upgrade an existing xpr-oracle install: pull source, rebuild, restart.
#
# Required because systemd's ExecStart runs the COMPILED dist/index.js,
# so a `git pull` alone doesn't pick up source changes — without npm
# install + npm run build, the daemon re-launches the same compiled
# bundle as before. This script does the whole thing in one command.
#
# Usage:  ./bin/upgrade.sh   (run from anywhere; auto-finds repo root)
#
# Exit codes: 0 = upgraded, 1 = failed (git, npm, or systemctl)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "→ git pull"
git pull --ff-only

echo "→ npm install"
npm install --silent --no-audit --no-fund

echo "→ npm run build"
npm run build

if systemctl list-unit-files xpr-oracle.service >/dev/null 2>&1 \
   && systemctl list-unit-files xpr-oracle.service | grep -q '^xpr-oracle.service'; then
  echo "→ sudo systemctl restart xpr-oracle"
  sudo systemctl restart xpr-oracle
  sleep 2
  if systemctl is-active --quiet xpr-oracle; then
    echo "✓ xpr-oracle is active"
    echo "  tail logs: journalctl -u xpr-oracle -f -n 50  (or: journalctl -t xpr-oracle -f)"
  else
    echo "✗ xpr-oracle failed to come up; check 'systemctl status xpr-oracle'"
    exit 1
  fi
else
  echo "  (no systemd unit installed — restart your foreground daemon manually)"
fi

echo "✓ upgrade complete: $(grep '"version"' package.json | sed 's/[^0-9.]//g')"
