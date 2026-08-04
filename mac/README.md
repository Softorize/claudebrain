# ClaudeBrain for macOS

An Electron shell around the claudebrain server + viewer. The app embeds the
compiled engine from `../dist` (synced into `engine/` at build time), starts
the server in-process on `127.0.0.1:4519`, and shows the synapse graph in a
native window. If a CLI/brew `claudebrain` server is already running, the app
reuses it instead of starting a second one — both entry points share
`~/.claude-brain`.

On first launch the app offers to install the Claude Code hooks (same as
`claudebrain install-hooks`); the Server menu can install/uninstall them,
fire a demo session, or open the viewer in a browser.

## Build

```bash
# once: build the engine
cd .. && npm install && npm run build

cd mac
npm install
npm run pack   # unsigned .app in dist/mac-universal (or mac-arm64) for testing
npm run dist   # dmg + zip; signs + notarizes when the env below is present
```

## Signed + notarized release

Uses the same identity and flow as wisparm — see
`~/projects/wisparm/wiki/pages/runbooks/mac-developer-id-signing.md` for the
full runbook (build keychain import, gotchas, verification).

```bash
KCPASS=$(sed -n 's/^P12 password: //p' ~/projects/wisparm/mac/certs/wisparm-developer-id.p12.password)
security unlock-keychain -p "$KCPASS" ~/Library/Keychains/build.keychain-db
security set-keychain-settings ~/Library/Keychains/build.keychain-db
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" ~/Library/Keychains/build.keychain-db

export CSC_KEYCHAIN="$HOME/Library/Keychains/build.keychain-db"
export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_X7QFM7ZJ3V.p8"
export APPLE_API_KEY_ID="X7QFM7ZJ3V"
export APPLE_API_ISSUER="98b72462-996e-45e2-a472-8456c18e6c30"
npm run dist

# electron-builder notarizes+staples the .app but NOT the dmg container:
xcrun notarytool submit dist/ClaudeBrain-*-universal.dmg \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple dist/ClaudeBrain-*-universal.dmg

# verify
spctl -a -vvv --type exec dist/mac-universal/ClaudeBrain.app   # Notarized Developer ID
xcrun stapler validate dist/mac-universal/ClaudeBrain.app
xcrun stapler validate dist/ClaudeBrain-*-universal.dmg
lipo -archs dist/mac-universal/ClaudeBrain.app/Contents/MacOS/ClaudeBrain  # x86_64 arm64
```

## Icon / dmg art

`build/icon.icns` is generated from a 1024×1024 PNG with
`scripts/make-icns.sh <png>`. `scripts/render-asset.js` renders a
self-contained HTML file to PNG (with alpha) via Electron offscreen — used to
produce the icon and `build/dmg-background{,@2x}.png`.
