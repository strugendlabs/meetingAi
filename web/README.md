# MeetingAI website

Static Next.js site for the MIT-licensed [MeetingAI source](https://github.com/strugendlabs/meetingAi). Messaging distinguishes Gemini BYOK from local Whisper + Ollama. Transcript animation is an illustrative sample, not a live model call.

```bash
npm ci
npm run dev
npm run build
```

The production files are in `out/`, with pages `/`, `/download/`, and `/privacy/`.

## Publish the source-preview site

- **Existing website / static host:** upload `out/` at your domain root. No app backend is needed.
- **GitHub Pages:** build with `NEXT_PUBLIC_BASE_PATH=/meetingAi npm run build`, then deploy `out/` as the Pages artifact for this repository. Configure Pages to use GitHub Actions. A custom root domain should use an empty base path.
- **Cloudflare Pages or another static host:** set the project directory to `web`, build command to `npm run build`, and output directory to `out`.

The GitHub source links work without a binary release. No hosting provider is configured or published automatically by this repository.

## Attach a verified binary later

Upload a signed/notarized DMG and checksum to a versioned GitHub Release. Supply its exact HTTPS asset URLs when building the website:

```dotenv
NEXT_PUBLIC_DOWNLOAD_URL=https://github.com/strugendlabs/meetingAi/releases/download/v0.1.0/MeetingAI_0.1.0_aarch64.dmg
NEXT_PUBLIC_MAC_NOTARIZED=true
NEXT_PUBLIC_MAC_CHECKSUM_URL=https://github.com/strugendlabs/meetingAi/releases/download/v0.1.0/MeetingAI_0.1.0_aarch64.dmg.sha256
NEXT_PUBLIC_APP_VERSION=0.1.0
```

These are examples, not existing assets. The Mac button stays unavailable unless a URL and notarization assertion are provided. Set the flag only after the [release process](../release/MAC-DISTRIBUTION.md) and a clean-Mac installation test pass. Open-source licensing does not remove macOS signing requirements.

Optional Windows release URL/size and Mac size fields are listed in `.env.example`. All `NEXT_PUBLIC_*` values are public build-time configuration; never put secrets in them. Rebuild the website when a download changes.
