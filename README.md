# MeetingAI

**Your meetings. Your models. Your notes.**

An open-source desktop meeting notetaker with local storage and a choice of AI providers. Bring your own **Gemini API key**, or run **Whisper + Ollama locally**. No MeetingAI account, subscription, telemetry, or hosted backend.

[MIT license](LICENSE) · [Local AI setup](docs/LOCAL-AI.md) · [Privacy](PRIVACY.md) · [Build & release](release/MAC-DISTRIBUTION.md)

> Early preview. Build from source today. A signed, notarized Mac download is not available yet. macOS Apple Silicon is the primary tested platform. The Windows installer workflow builds and tests a Windows 11 x64 preview; audio quality still needs validation on Windows hardware. Linux is not supported.

## Choose where inference runs

| | Gemini · bring your own key | Local · Whisper + Ollama |
|---|---|---|
| Speech recognition | Audio sent directly to Google Gemini | Audio sent to a whisper.cpp server on this computer |
| Summaries and text translation | Transcript text sent directly to Google | Transcript text sent to a downloaded Ollama model on this computer |
| Spoken live translation | Optional Gemini Live feature | Not available |
| Storage | Local SQLite | Local SQLite |
| Setup | Enter your Gemini API key in the app | Start two local servers and select a model |
| Costs | Your Google API usage | Your hardware; no per-request API fee |

Local mode accepts loopback URLs only, rejects cloud-backed Ollama models, and never falls back to Gemini. Ollama handles **text**, not microphone transcription; Whisper handles speech. Optional Google Calendar sync still contacts Google in either mode. Leave it disconnected for an offline meeting workflow. Model downloads need internet access once.

## What you get

- Microphone and system-audio capture, with independent meters, permission diagnostics, and retry controls.
- Timestamped **You / Them** transcripts, grouped into readable turns, with search and copy. “Them” is the remote audio source, not identification of every person on a group call.
- Summaries, explicit action items, and key notes using your selected provider.
- Saved transcript translation, with progress and retry. Local recognition arrives in short chunks rather than word by word.
- Your own notes beside the transcript, saved automatically.
- PDF, Word, and Markdown export. Bundled fonts keep Hindi and Latin text readable in offline PDF exports.
- Optional Google Calendar connection and optional spoken translation in Gemini mode.

Recognition and summaries can be wrong, especially with overlapping speech, names, noise, or mixed languages. Review important details. Use headphones to reduce cross-talk between the two audio sources. Start recording only with participants' agreement.

## Build on macOS

Requires Apple Silicon, macOS 13+, Node.js 22+, Rust stable, and Xcode Command Line Tools (including Swift).

```bash
git clone https://github.com/strugendlabs/meetingAi.git
cd meetingAi/desktop
npm ci
./scripts/build-sidecar.sh
npm run tauri dev
```

Create a local app bundle with `npm run tauri build`. Generated binaries are intentionally excluded from Git. Source builds use ad-hoc signing; macOS may request permissions again after a rebuild. [Signing details](desktop/scripts/macos-signing.md).

In onboarding or **Settings → Your AI, your choice**, choose:

- **Gemini · BYOK**: enter your own key from [Google AI Studio](https://aistudio.google.com/apikey). It goes into the OS credential vault. Background reads never open Keychain dialogs. Use **Unlock saved key** if access is needed; if macOS asks, choose **Always Allow** for this app. Repeated installs with different signing identities can require consent again. Builds do not embed developer `.env` credentials.
- **Local · Ollama**: follow [the local setup guide](docs/LOCAL-AI.md), refresh models, choose a downloaded model, and test both connections. No Gemini key is needed. Choose the spoken language in the Whisper settings separately from your summary language.

## Windows 11 · Tauri and Rust

Requires Windows 11 x64, Node.js 22+, Rust stable and Visual Studio Build Tools with Desktop development with C++. In an MSVC developer PowerShell:

```powershell
cd desktop
npm ci
npm run tauri build -- --bundles nsis
```

Windows call audio runs inside the Rust app using WASAPI process loopback, excluding MeetingAI and its WebView2 processes. There is no separate audio executable. Launching MeetingAI again focuses the existing window. Microsoft WebView2 still uses its normal browser subprocesses.

The [Windows installer workflow](.github/workflows/windows-build.yml) produces an NSIS installer, installs it, and checks native window startup and duplicate-launch handling. Download the `MeetingAI-Windows-x64-preview` artifact from a successful run. This preview is **unsigned** and Windows may show SmartScreen warnings. The separate [signed release workflow](.github/workflows/windows-release.yml) requires an Authenticode certificate. [Windows packaging and testing](docs/WINDOWS.md).

## Development and tests

```bash
cd desktop
npm test
npm run build
cd src-tauri
cargo test --lib
```

On macOS, build the Swift audio helper first. Local inference integration tests are opt-in and require running services; [test instructions](docs/LOCAL-AI.md#test-the-connectors). Gemini integration tests require an explicitly supplied `GEMINI_API_KEY`.

```text
desktop/           Tauri 2 · React · TypeScript · Rust
desktop/sidecar/   Swift system-audio capture
desktop/src-tauri/src/windows_audio.rs  In-process Rust WASAPI capture
web/               Static Next.js website
```

## Website and downloads

```bash
cd web
npm ci
npm run build
```

Deploy `web/out/` to any static host. The website links to this source repository. The Mac download button is enabled only when an HTTPS release URL and `NEXT_PUBLIC_MAC_NOTARIZED=true` are supplied at build time. Host future verified binaries on GitHub Releases and point the website at the exact release asset. [Website configuration](web/README.md) · [Mac release process](release/MAC-DISTRIBUTION.md).

## Privacy and license

MeetingAI has no service that receives your meetings. **Gemini mode is cloud processing** under your Google account; local mode processes speech and text on loopback services you run. Meetings are stored in a local SQLite database without application-level encryption. API keys and OAuth tokens use the OS credential vault. See [PRIVACY.md](PRIVACY.md) for data flows, retention, and deletion.

MeetingAI source is licensed under [MIT](LICENSE). Third-party dependencies and bundled fonts retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Contributions and reproducible bug reports are welcome. Please use synthetic transcripts and never include API keys or private meeting recordings in issues.
