# Local speech recognition and Ollama

MeetingAI uses **whisper.cpp for speech → text** and **Ollama for summaries and text translation**. Both servers must run on the same computer as the app. Remote servers and Ollama cloud models are deliberately unsupported in local mode. No Gemini key is needed and failed local requests never trigger cloud inference.

## 1. Start Ollama

Install [Ollama](https://ollama.com/download), download a text-generation model suited to your RAM, and start its server. For example:

```bash
ollama pull qwen3:4b
OLLAMA_NO_CLOUD=1 ollama serve
```

If the Ollama app already owns port 11434, quit it before starting a second server. Alternatively disable its cloud features in `~/.ollama/server.json` with `"disable_ollama_cloud": true` and restart it; see [Ollama's FAQ](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features). MeetingAI also checks that the selected model has local weights before sending text. It does not install models or change your Ollama configuration for you.

## 2. Start whisper.cpp

On macOS, install the server and download a **multilingual** model. `.en` models recognize English only.

```bash
brew install whisper-cpp
mkdir -p "$HOME/.cache/whisper-models"
curl -fL --retry 3 \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin \
  -o "$HOME/.cache/whisper-models/ggml-base.bin"
whisper-server \
  --model "$HOME/.cache/whisper-models/ggml-base.bin" \
  --host 127.0.0.1 --port 8080 --language auto
```

The `base` model is a small starting point, not an accuracy guarantee. For Hindi and mixed-language meetings, compare a multilingual `small` or `medium` model on your hardware. Larger models use more memory and take longer. Server installation on Windows follows [whisper.cpp's instructions](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server).

MeetingAI calls whisper.cpp's `POST /inference` multipart endpoint with a 16 kHz mono WAV, `language=auto`, and `translate=false`. An OpenAI-compatible `/v1/audio/transcriptions` endpoint is not interchangeable with this connector.

## 3. Connect in MeetingAI

1. Open Settings → Your AI, your choice → **Local · Ollama**.
2. Keep Ollama URL `http://127.0.0.1:11434`, or enter your loopback port.
3. Click **Refresh models**, select a downloaded text model, then **Test Ollama**. This checks model availability and capabilities; a summary exercises generation.
4. Set Whisper URL to `http://127.0.0.1:8080` and click **Test Whisper**. This sends one second of silence to verify the audio endpoint, not recognition accuracy.
5. Start a short meeting. Check both audio meters, speak a known sentence, then stop and review the transcript and summary.

Local capture buffers speech in memory and commits a chunk on a pause or a ten-second window. Finishing a meeting waits for queued recognition. Slow inference can delay text; a full queue produces an explicit skipped-audio warning. Saved-meeting text translation is on demand. Spoken live translation requires Gemini mode.

For offline inference, download models beforehand and keep Google Calendar disconnected. The local servers' own configuration, logging, and model behavior remain under your control. MeetingAI cannot police other applications running on your computer.

## Troubleshooting

- **No local models found:** use `ollama list` and download a model. Cloud tags and models without local weight metadata are excluded.
- **Cannot reach server:** check that the relevant server is running. The native bridge uses loopback only, ignores HTTP proxies, and does not follow redirects. LAN IPs, HTTPS URLs, URL credentials, paths, and reverse-proxy URLs are rejected.
- **Meter moves but recognition fails:** verify the Whisper port and model. The local connector expects whisper.cpp, not the Ollama chat endpoint.
- **Poor Hindi recognition:** ensure the Whisper model filename does not end in `.en.bin`; use a larger multilingual model if your hardware can keep up.
- **Empty/truncated summary:** try a text model with better instruction following. Long meetings are summarized in sections, then combined; failures preserve the transcript.
- **Repeated words or wrong speaker:** use headphones and check audio routing. Labels distinguish microphone from system audio, not each participant.

## Test the connectors

The default tests mock local servers and test routing, cloud rejection, WAV encoding, queue draining, failures, and long transcripts:

```bash
cd desktop
npm test
```

The opt-in Rust integration test uses the actual native bridge to discover models, inspect model metadata, generate a reply, and submit WAV audio to whisper.cpp. On macOS, create a synthetic fixture:

```bash
say -v Samantha -r 145 -o /tmp/meetingai-test.aiff \
  "We agreed to send the report on Friday. Alice will prepare the draft. Bob will review it."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/meetingai-test.aiff /tmp/meetingai-test.wav
cd desktop/src-tauri
MEETINGAI_TEST_MODEL=qwen3:4b \
MEETINGAI_TEST_WAV=/tmp/meetingai-test.wav \
cargo test --lib local_services_round_trip -- --ignored
```

Optional `MEETINGAI_TEST_OLLAMA_URL` and `MEETINGAI_TEST_WHISPER_URL` select alternative loopback ports. No real meeting or key is included in the fixture. Tests verify connector behavior; they are not an accuracy benchmark across languages and hardware.
