// Admin-provisioned credentials, baked in at build time from desktop/.env
// (VITE_* variables — see .env.example). Precedence: values the user entered
// in-app (Keychain key, Settings fields) always win; these are fallbacks so
// an admin can ship a ready-to-use build without any per-user setup.

import { safeInvoke } from "./tauri";

export interface AdminConfig {
  geminiApiKey: string;
  googleClientId: string;
  googleClientSecret: string;
}

function env(name: string): string {
  const v = (import.meta.env as Record<string, unknown>)[name];
  return typeof v === "string" ? v.trim() : "";
}

export const ADMIN_CONFIG: AdminConfig = {
  geminiApiKey: env("VITE_GEMINI_API_KEY"),
  googleClientId: env("VITE_GOOGLE_CLIENT_ID"),
  googleClientSecret: env("VITE_GOOGLE_CLIENT_SECRET"),
};

/**
 * Whether to read the Gemini API key from the Keychain at all.
 *
 * Reading the Keychain triggers a macOS "allow access" prompt whenever the
 * stored item was created by a different code identity (every past build), and
 * that trust does not reliably persist for a self-signed app — so the prompt
 * kept reappearing. The read is only actually NEEDED when the user stored their
 * OWN key; when an admin `.env` key already covers us, we skip the read (and
 * its prompt) entirely. `hasUserKey` is a non-secret flag in the settings store
 * set whenever the user saves/removes a key in-app.
 */
export function shouldReadUserGeminiKey(hasUserKey: boolean, adminKeyPresent: boolean): boolean {
  if (hasUserKey) return true; // the user's own key lives only in the Keychain
  if (adminKeyPresent) return false; // admin .env covers it — no read, no prompt
  return true; // legacy: no admin key, a key may have been stored pre-flag
}

/**
 * Gemini API key resolution: the user's Keychain key (when they stored one) →
 * admin .env default. Returns the key plus where it came from so UIs can label
 * the state, and the Keychain error (if any) so a real Keychain failure is
 * never silently masked when no admin fallback exists.
 *
 * `hasUserKey` (from settings) gates the Keychain read — see
 * `shouldReadUserGeminiKey`. Passing `false` with an admin key present means
 * the Keychain is never touched, so no macOS prompt appears.
 */
export async function resolveGeminiApiKey(hasUserKey: boolean): Promise<{
  key: string | null;
  source: "keychain" | "admin" | "none";
  keychainError?: string;
}> {
  let keychainError: string | undefined;
  if (shouldReadUserGeminiKey(hasUserKey, !!ADMIN_CONFIG.geminiApiKey)) {
    try {
      const v = await safeInvoke<string | null>("keychain_get", { key: "gemini_api_key" });
      if (v) return { key: v, source: "keychain" };
    } catch (e) {
      keychainError = e instanceof Error ? e.message : String(e);
    }
  }
  if (ADMIN_CONFIG.geminiApiKey) {
    return { key: ADMIN_CONFIG.geminiApiKey, source: "admin", keychainError };
  }
  return { key: null, source: "none", keychainError };
}

/**
 * Google OAuth client resolution: Settings fields → admin .env defaults.
 * Resolution is PAIRWISE — a user-supplied client ID is never mixed with the
 * admin secret (mismatched pairs fail OAuth in confusing ways).
 */
export function resolveGoogleClient(s: {
  googleClientId: string;
  googleClientSecret: string;
}): { clientId: string; clientSecret: string; fromAdmin: boolean } {
  const userId = s.googleClientId.trim();
  if (userId) {
    return { clientId: userId, clientSecret: s.googleClientSecret.trim(), fromAdmin: false };
  }
  return {
    clientId: ADMIN_CONFIG.googleClientId,
    clientSecret: ADMIN_CONFIG.googleClientSecret,
    fromAdmin: !!ADMIN_CONFIG.googleClientId,
  };
}
