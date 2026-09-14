# Put MeetingAI on your website

The MIT-licensed source can be published without an Apple Developer membership. A trusted public Mac binary requires Developer ID signing and notarization. Local ad-hoc/self-signed builds do not establish trust on other Macs.

## Recommended route

Build prerequisites: an Apple Silicon Mac, Xcode Command Line Tools, Node.js, Rust and installed desktop dependencies (`npm ci` from `desktop`).

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/). It costs US$99 per membership year, or local currency where available. Use an organization membership if the publisher should be your company; Apple requires its legal entity information and usually a D‑U‑N‑S number.
2. Create a **Developer ID Application** certificate in your Apple team and install it with its private key in your Mac's Keychain. Keep the bundle identifier `com.meetingai.desktop` and signing team stable across updates.
3. Set up a notarization credential profile using `xcrun notarytool store-credentials meetingai-notary`. Follow its interactive prompts for your Apple ID, team ID and app-specific password. Credentials remain in Keychain.
4. From `desktop`, run:

   ```bash
   APPLE_SIGNING_IDENTITY='Developer ID Application: Your Legal Name (TEAMID)' \
   APPLE_NOTARY_PROFILE='meetingai-notary' \
   bash scripts/release-macos.sh
   ```

   Replace the certificate name with your actual identity. The script builds the Apple Silicon helper and app, runs the frontend tests, signs with the hardened runtime, notarizes and staples the app, then packages, signs, notarizes and staples the DMG. It verifies Gatekeeper acceptance and writes the DMG, SHA-256 checksum and `release.json` to `release/macos-public/`. Public builds exclude all private developer `.env` credentials.
5. Test that exact DMG downloaded through a browser on a separate Mac without your development certificates. Install to Applications, grant Microphone and Screen & System Audio Recording access, restart if macOS requests it, then verify both audio meters and a short Hindi/English call. Confirm export and first launch while offline (the notarization ticket should be stapled; Gemini needs internet, while configured local inference does not).
6. Upload the verified files, configure `web/.env.local` as below, and deploy the static `web/out` folder from `npm run build`.

   ```dotenv
   NEXT_PUBLIC_DOWNLOAD_URL=https://downloads.your-domain.com/MeetingAI_0.1.0_aarch64.dmg
   NEXT_PUBLIC_MAC_NOTARIZED=true
   NEXT_PUBLIC_MAC_CHECKSUM_URL=https://downloads.your-domain.com/MeetingAI_0.1.0_aarch64.dmg.sha256
   NEXT_PUBLIC_APP_VERSION=0.1.0
   NEXT_PUBLIC_DOWNLOAD_SIZE=REPLACE_WITH_ACTUAL_SIZE
   ```

   Set `NEXT_PUBLIC_MAC_NOTARIZED=true` only after the script and clean-Mac test succeed. This flag is a publishing assertion, not an independent notarization check. Leave it false for local builds. A URL alone never enables the Mac download. Use versioned filenames; rebuild the website when publishing a new version. No in-app automatic updater is installed yet.

## Hosting choices

| Route | Use when | How |
| --- | --- | --- |
| Existing website + GitHub Releases | Fastest beta launch with a public release repository | Attach DMG/checksum to a GitHub release; link the website button directly to the versioned asset. A private repository's release assets require login, so use a dedicated public binary-release repository if source must remain private. |
| Static site + Cloudflare R2 | Branded downloads with your own domain | Host `web/out` on your existing static host or Cloudflare Pages; put binaries in R2 behind `downloads.your-domain.com`. Use an R2 custom domain for production, not its development `r2.dev` URL. |
| Existing CDN/object storage | You already use S3 or an equivalent | Keep the website where it is and serve immutable, versioned DMGs over HTTPS. Supply a checksum link and cache the file under its versioned name. |

For DMGs use `Content-Type: application/x-apple-diskimage` and `Content-Disposition: attachment; filename="MeetingAI_0.1.0_aarch64.dmg"`. Do not modify a signed artifact after notarization; regenerate it through the script. Keep older downloads available so a release can be rolled back.

## What users still need

Signing and notarization remove the usual unidentified-developer block. macOS can still show its normal first-open confirmation and consent prompts for microphone/system audio; a website download cannot skip those. Do not ask users to disable Gatekeeper, remove quarantine, or install your local signing certificate.

Users choose **Gemini BYOK** or **local Whisper + Ollama**. Gemini users enter their own key, with API costs and quotas on their Google project. Local users install two servers and download compatible models. The public app contains neither a shared API key nor bundled model weights. Calendar sync is optional and needs a Google OAuth desktop client. Keep setup instructions beside the download so people can choose the right mode before installing.

This release is Apple Silicon only (M1 or newer), macOS 13+. An Intel/universal release needs separately compiled native helpers and clean-device testing; changing a website label does not add Intel support.

Sources: [Apple membership](https://developer.apple.com/support/compare-memberships/), [Developer ID](https://developer.apple.com/developer-id/), [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [GitHub release assets](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [R2 custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/).
