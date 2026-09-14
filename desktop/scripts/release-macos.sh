#!/usr/bin/env bash
# Build a public Apple Silicon DMG. Requires Developer ID + notarytool profile.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DESKTOP_DIR"
: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY to your Developer ID Application certificate name}"
: "${APPLE_NOTARY_PROFILE:?Set APPLE_NOTARY_PROFILE to a notarytool Keychain profile}"
if [[ "$APPLE_SIGNING_IDENTITY" != "Developer ID Application: "* ]]; then
  echo "A public release requires a Developer ID Application certificate; local/ad-hoc signing cannot be notarized." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Run this Apple Silicon release on an arm64 Mac." >&2
  exit 1
fi
security find-identity -v -p codesigning | grep -F -- "$APPLE_SIGNING_IDENTITY" >/dev/null
xcrun notarytool history --keychain-profile "$APPLE_NOTARY_PROFILE" >/dev/null

RELEASE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/meetingai-release.XXXXXX")"
trap 'rm -rf "$RELEASE_TMP"' EXIT
export RELEASE_TMP APPLE_SIGNING_IDENTITY
export MEETINGAI_PUBLIC_RELEASE=1
export VITE_GEMINI_API_KEY="" VITE_GOOGLE_CLIENT_ID="" VITE_GOOGLE_CLIENT_SECRET=""
python3 - <<'PY'
import json, os
from pathlib import Path
Path(os.environ['RELEASE_TMP'], 'tauri-public.json').write_text(json.dumps({
  'bundle': {'macOS': {'signingIdentity': os.environ['APPLE_SIGNING_IDENTITY'], 'hardenedRuntime': True}}
}))
PY

npm test
bash scripts/build-sidecar.sh
npm run tauri build -- --target aarch64-apple-darwin --bundles app --config "$RELEASE_TMP/tauri-public.json"
APP_PATH="$DESKTOP_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/MeetingAI.app"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dv "$APP_PATH" 2>&1 | grep -F 'runtime' >/dev/null

notarize() {
  xcrun notarytool submit "$1" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait --output-format json > "$RELEASE_TMP/notary-result.json"
  python3 - "$RELEASE_TMP/notary-result.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
if r.get('status') != 'Accepted':
    raise SystemExit('Notarization failed: ' + str(r.get('status')) + '; submission ' + str(r.get('id')))
print('Notarization accepted: ' + r['id'])
PY
}

ditto -c -k --keepParent "$APP_PATH" "$RELEASE_TMP/MeetingAI.zip"
notarize "$RELEASE_TMP/MeetingAI.zip"
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl --assess --type execute --verbose=2 "$APP_PATH"

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')).version")"
OUTPUT_DIR="$DESKTOP_DIR/../release/macos-public"
mkdir -p "$OUTPUT_DIR" "$RELEASE_TMP/image"
ditto "$APP_PATH" "$RELEASE_TMP/image/MeetingAI.app"
ln -s /Applications "$RELEASE_TMP/image/Applications"
DMG_PATH="$OUTPUT_DIR/MeetingAI_${VERSION}_aarch64.dmg"
hdiutil create -volname MeetingAI -srcfolder "$RELEASE_TMP/image" -ov -format UDZO "$DMG_PATH"
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG_PATH"
notarize "$DMG_PATH"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
codesign --verify --strict "$DMG_PATH"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_PATH"
export DMG_PATH VERSION
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
p = Path(os.environ['DMG_PATH'])
digest = hashlib.sha256(p.read_bytes()).hexdigest()
p.with_suffix('.dmg.sha256').write_text(digest + '  ' + p.name + '\n')
p.with_name('release.json').write_text(json.dumps({
  'version': os.environ['VERSION'], 'filename': p.name, 'bytes': p.stat().st_size,
  'sha256': digest, 'architecture': 'aarch64', 'minimumMacOS': '13.0', 'notarized': True
}, indent=2) + '\n')
print('Verified public release: ' + str(p))
PY
