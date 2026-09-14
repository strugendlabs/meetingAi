# macOS signing

Source builds use ad-hoc signing by default. This is sufficient for local development, but is not a trusted public release identity. Rebuilding with a different identity can cause macOS to request microphone, screen/audio capture, and Keychain permissions again.

For a consistent development identity, create your own code-signing certificate in Keychain Access and build with `APPLE_SIGNING_IDENTITY="Your certificate name" npm run tauri build`. Keep private keys and keychain passwords outside this repository.

Public distribution requires a Developer ID Application certificate, hardened runtime, and notarization. Follow [the release guide](../../release/MAC-DISTRIBUTION.md) and run `scripts/release-macos.sh`. Never publish a local self-signed binary as a notarized release.
