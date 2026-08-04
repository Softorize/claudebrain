#!/bin/bash
# Build build/icon.icns from a 1024x1024 PNG using pure macOS tooling.
#   scripts/make-icns.sh <icon_1024.png>
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$1"

rm -rf build/icon.iconset
mkdir -p build/icon.iconset
sips -z 16 16     "$SRC" --out build/icon.iconset/icon_16x16.png >/dev/null
sips -z 32 32     "$SRC" --out build/icon.iconset/icon_16x16@2x.png >/dev/null
sips -z 32 32     "$SRC" --out build/icon.iconset/icon_32x32.png >/dev/null
sips -z 64 64     "$SRC" --out build/icon.iconset/icon_32x32@2x.png >/dev/null
sips -z 128 128   "$SRC" --out build/icon.iconset/icon_128x128.png >/dev/null
sips -z 256 256   "$SRC" --out build/icon.iconset/icon_128x128@2x.png >/dev/null
sips -z 256 256   "$SRC" --out build/icon.iconset/icon_256x256.png >/dev/null
sips -z 512 512   "$SRC" --out build/icon.iconset/icon_256x256@2x.png >/dev/null
sips -z 512 512   "$SRC" --out build/icon.iconset/icon_512x512.png >/dev/null
cp "$SRC"         build/icon.iconset/icon_512x512@2x.png
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset
echo "build/icon.icns written"
