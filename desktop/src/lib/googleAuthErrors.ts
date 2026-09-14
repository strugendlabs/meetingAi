// Turns the raw error strings surfaced by the Rust oauth.rs commands
// (`google_oauth_start` / `google_oauth_refresh`) into actionable copy for
// the common failure modes, without hiding the original text — callers that
// want it verbatim (e.g. a "copy error details" action) should keep the raw
// message around separately.
//
// Recognized shapes coming out of oauth.rs:
//   `token exchange failed (400): {"error":"redirect_uri_mismatch",...}`
//   `token refresh failed (400): {"error":"invalid_client",...}`
//   `OAuth error from Google: access_denied`   (redirect carried ?error=...)

const REDIRECT_URI_MISMATCH_MESSAGE =
  "Your Google OAuth client doesn't allow this app's sign-in address. If it's a Web application client, add these to Authorized redirect URIs: http://127.0.0.1:51739, http://127.0.0.1:51740, http://127.0.0.1:51741 — or switch to a Desktop app client type, which needs no redirect URIs.";

const ACCESS_DENIED_MESSAGE =
  "Sign-in was cancelled, or your Google account isn't added as a test user yet (Console → OAuth consent screen → Audience → Test users).";

const INVALID_CLIENT_MESSAGE =
  "The Client ID or Secret is incorrect. Check Settings → Google (or your desktop/.env if admin-configured).";

const SUPERSEDED_MESSAGE =
  "This sign-in attempt was replaced by a newer one — if you clicked \"Sign in with Google\" more than once, finish in the most recent browser tab and try again.";

const TIMED_OUT_MESSAGE =
  "Sign-in didn't complete. If the browser showed \"Access blocked\" or \"app isn't verified\", your Google account must be added as a Test user (Console → OAuth consent screen → Audience → Test users), then click Continue on that screen. Otherwise finish the sign-in within a few minutes and try again.";

const KNOWN_GOOGLE_ERROR_CODES: Record<string, string> = {
  redirect_uri_mismatch: REDIRECT_URI_MISMATCH_MESSAGE,
  access_denied: ACCESS_DENIED_MESSAGE,
  invalid_client: INVALID_CLIENT_MESSAGE,
};

/** Pull Google's `error` field out of either raw-message shape, if present. */
function extractGoogleErrorCode(rawMessage: string): string | null {
  const jsonField = rawMessage.match(/"error"\s*:\s*"([^"]+)"/);
  if (jsonField) return jsonField[1];
  const redirectError = rawMessage.match(/OAuth error from Google:\s*(\S+)/);
  if (redirectError) return redirectError[1];
  return null;
}

/**
 * Turn a raw Google-sign-in error string into a clear, actionable message.
 * Unrecognized errors fall back to the raw message unchanged — this only
 * adds clarity on top, it never hides information.
 */
export function describeGoogleAuthError(rawMessage: string): string {
  const code = extractGoogleErrorCode(rawMessage);
  if (code && code in KNOWN_GOOGLE_ERROR_CODES) {
    return KNOWN_GOOGLE_ERROR_CODES[code];
  }
  if (rawMessage.includes("superseded by a newer attempt")) {
    return SUPERSEDED_MESSAGE;
  }
  if (rawMessage.includes("OAuth timed out waiting for the browser redirect")) {
    return TIMED_OUT_MESSAGE;
  }
  return rawMessage;
}
