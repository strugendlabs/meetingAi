# Windows preview

MeetingAI uses Tauri 2, React and Rust on Windows 11 x64. Microphone capture runs through WebView2; call audio runs in the app's Rust WASAPI thread. Process loopback excludes MeetingAI and its descendants, preventing translated output from being captured again. No C++ audio helper is shipped.

## Build and install

Install Node.js 22+, Rust stable, and Microsoft's Visual Studio Build Tools with the Desktop development with C++ workload. The Microsoft linker and Windows SDK are required by Rust's MSVC toolchain; the audio implementation itself is Rust.

```powershell
cd desktop
npm ci
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build -- --bundles nsis
```

The installer is under `desktop/src-tauri/target/release/bundle/nsis/`. It installs for the current user and uses Microsoft WebView2. The installer may need internet to install the WebView2 runtime when it is missing.

The repository's **Windows installer** Actions workflow runs these checks on Windows, installs the resulting package into an isolated runner profile, opens its native window, and verifies a second launch exits while the first remains open. Its downloadable artifact includes the installer and a SHA-256 checksum. The installer is an unsigned preview; do not describe it as signed or warning-free.

## Test audio on a Windows PC

1. In Windows Settings, allow microphone access for desktop apps. Select the intended input in MeetingAI.
2. Choose Gemini BYOK or configure both local Whisper and Ollama services using the [local guide](LOCAL-AI.md).
3. With headphones connected, start a meeting and speak. Verify the microphone meter moves and a **You** turn appears.
4. Play a test sentence in another app. Verify the call meter moves and a **Them** turn appears. Enable spoken translation if testing Gemini and confirm MeetingAI's playback is not transcribed back into itself.
5. Stop, reopen the saved meeting, and verify the transcript and summary. Open MeetingAI a second time and confirm the existing window comes forward.

CI checks packaging and app startup. Its virtual runner does not establish microphone, output-device, Bluetooth, or recognition quality on real hardware. A device/permission error remains visible in the app with a retry or Windows Settings action.

## Signed public releases

The separate **Windows signed release** workflow requires an Authenticode certificate and signs the application and installer. Configure the repository secrets documented in that workflow, then dispatch it. A valid signature identifies the publisher; Windows reputation checks can still appear for new releases.

For website distribution, upload the verified installer and checksum to a GitHub Release and link to that exact asset. Keep preview downloads clearly labeled until hardware testing and signing are complete.

Implementation references: [Tauri single-instance plugin](https://v2.tauri.app/plugin/single-instance/) and [WASAPI Rust API](https://docs.rs/wasapi/0.24.0/wasapi/struct.AudioClient.html).
