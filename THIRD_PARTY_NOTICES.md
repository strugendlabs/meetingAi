# Third-party notices

MeetingAI's original source is MIT licensed. Third-party libraries retain their own licenses, recorded in the npm and Cargo packages resolved by the lockfiles.

Bundled PDF fonts:

- Noto Sans: SIL Open Font License 1.1, see `desktop/src/assets/fonts/OFL.txt`.
- Hind: SIL Open Font License 1.1, see `desktop/src/assets/fonts/Hind-OFL.txt`.

Ollama, whisper.cpp, and model weights are separate installations, not bundled in MeetingAI. Their software and model licenses apply independently. Gemini is an optional external API governed by Google's terms.

Windows audio capture uses the `wasapi` Rust crate (MIT). Single-instance handling uses `tauri-plugin-single-instance` (MIT OR Apache-2.0). Both are linked into the application; their license files are included in their Cargo source packages.
