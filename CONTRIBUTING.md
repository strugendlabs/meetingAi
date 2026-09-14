# Contributing

Bug reports, improvements, and documentation are welcome. By contributing original work, you agree to license it under the repository's MIT license.

Include your OS, app version, selected provider/model, what you expected, and what happened. For recognition issues, describe whether the microphone or system-audio meter moves. Use synthetic audio and transcript examples; remove keys, tokens, private meeting content, and personal paths from logs.

Keep provider routing explicit. Local mode must never silently call a cloud provider. Do not add telemetry or credentials to builds. Add tests for changes affecting audio lifecycle, data persistence, or provider boundaries. Run `npm test` and `npm run build` in `desktop`; run `cargo test --lib` in `desktop/src-tauri` after building the sidecar. Website changes should pass `npm run build` in `web`.

State which real devices and models you tested. Browser mocks do not validate native permissions or system-audio capture, and synthetic recognition tests do not establish language-wide accuracy.
