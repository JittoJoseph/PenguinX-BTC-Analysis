#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "Strategic Market Engine Deployment"
echo "Started: $(date)"
echo "========================================"

echo ""
echo ">>> Updating repository..."
git fetch origin
git reset --hard origin/main

echo ""
echo ">>> Entering backend..."
cd backend

echo ""
echo ">>> Installing dependencies..."
pnpm install --frozen-lockfile

echo ""
echo ">>> Building project..."
pnpm run build

echo ""
echo ">>> Reloading PM2..."
pm2 reload market-engine --update-env

echo ""
echo "========================================"
echo "Deployment completed successfully!"
echo "Finished: $(date)"
echo "========================================"