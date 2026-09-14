# Privacy

Updated 14 September 2026.

MeetingAI is a desktop app with no MeetingAI account, analytics, telemetry, or hosted inference backend. You choose its AI provider. Open source does not mean that every mode is offline.

## Local mode: Whisper + Ollama

Audio chunks go to a whisper.cpp server on your computer. Transcript text goes to a downloaded Ollama model for summaries and requested text translations. Only loopback HTTP addresses are accepted. The native client disables proxies and redirects; the app rejects cloud-backed Ollama models before sending meeting text. Failures do not trigger Gemini requests.

Disable Ollama cloud features, download models in advance, and leave optional Google Calendar disconnected for offline inference. These local services run independently; review their logging and configuration. MeetingAI does not guarantee what a modified local server does with a request.

## Gemini mode: your key, Google's service

Microphone and system audio go directly from your app to Google's Gemini API for recognition and optional spoken translation. Transcript text goes to Google for summaries and text translation. Your Google API terms, data handling settings, quotas, and billing apply. Data does not pass through a MeetingAI server. This mode is **not on-device inference**.

## Storage and deletion

Meeting text, notes, summaries, translations, and meeting metadata are stored in SQLite in the app data directory. The database is not encrypted by MeetingAI; your device and disk protections apply. On macOS the app data directory is normally `~/Library/Application Support/com.meetingai.desktop/`.

MeetingAI does not save raw microphone or system-audio recordings. Audio is buffered in memory while capture and queued inference run. Exported documents are saved wherever you choose. Your local AI servers or cloud provider may have their own retention behavior.

Deleting a meeting removes its records from the app. SQLite deletion is not a forensic secure erase, and exports, backups, provider-side data, and external server logs are separate. Uninstalling the app does not automatically remove its data directory or credential-vault entries.

Gemini API keys and Google OAuth tokens are stored through the OS credential vault (macOS Keychain / Windows Credential Manager), not the meeting database. They are loaded into memory when needed. Google desktop OAuth client configuration and local server/model settings are stored in preferences. Source and release builds exclude developer `.env` credentials.

## Optional Google Calendar

Connecting Calendar contacts Google even when local AI is selected. The app requests read-only calendar access and basic account profile information. Tokens go into the credential vault. Disconnect in Settings to remove the app's stored connection tokens. You can also revoke access in your Google account.

## Website

The included static website has no app-added analytics or trackers. Its hosting provider and GitHub may keep normal access logs when you visit pages or download source/releases. External links take you to services with their own policies.

Please keep private transcripts, recordings, and API keys out of public issues. Use a synthetic example to report bugs.
