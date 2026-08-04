#!/bin/bash
# Copy the compiled claudebrain engine (../dist) into mac/engine/ so
# electron-builder can bundle it. The engine is ESM; the dropped-in
# package.json scopes "type": "module" to engine/ while main.js stays CJS.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f ../dist/server.js ] || [ ! -f ../dist/web/app.js ]; then
  echo "error: ../dist is missing or incomplete — run 'npm run build' in the repo root first" >&2
  exit 1
fi

rm -rf engine
cp -R ../dist engine
printf '{\n  "type": "module"\n}\n' > engine/package.json
echo "engine synced from ../dist ($(find engine -type f | wc -l | tr -d ' ') files)"
