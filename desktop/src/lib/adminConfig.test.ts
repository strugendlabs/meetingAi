import { describe, expect, it } from "vitest";
import { resolveGoogleClient, shouldReadUserGeminiKey } from "./adminConfig";
import { sanitizeDetail } from "../components/Meeting/StatusBar";

describe("shouldReadUserGeminiKey", () => {
  // The whole point: skip the Keychain read (and its macOS prompt) whenever an
  // admin .env key already covers us and the user hasn't stored their own.
  it("skips the read when an admin key covers it and the user stored none", () => {
    expect(shouldReadUserGeminiKey(false, true)).toBe(false);
  });

  it("reads when the user stored their own key (even if an admin key exists)", () => {
    expect(shouldReadUserGeminiKey(true, true)).toBe(true);
    expect(shouldReadUserGeminiKey(true, false)).toBe(true);
  });

  it("reads in the legacy case: no admin key and no tracked user key", () => {
    // A key may have been stored before the flag existed — must still be read.
    expect(shouldReadUserGeminiKey(false, false)).toBe(true);
  });
});

describe("resolveGoogleClient", () => {
  it("prefers user-entered settings values", () => {
    const r = resolveGoogleClient({
      googleClientId: "user-id.apps.googleusercontent.com",
      googleClientSecret: "user-secret",
    });
    expect(r.clientId).toBe("user-id.apps.googleusercontent.com");
    expect(r.clientSecret).toBe("user-secret");
    expect(r.fromAdmin).toBe(false);
  });

  it("trims whitespace-only settings before falling back", () => {
    // Build-time env is empty in tests, so whitespace settings resolve empty.
    const r = resolveGoogleClient({ googleClientId: "   ", googleClientSecret: "" });
    expect(r.clientId).toBe("");
    expect(r.fromAdmin).toBe(false);
  });
});

describe("sanitizeDetail", () => {
  it("strips model ids from connect errors", () => {
    const msg = "Gemini Live connect failed (model gemini-3.1-flash-live-preview): code=1008";
    const out = sanitizeDetail(msg);
    expect(out).not.toMatch(/gemini-/i);
    expect(out).toContain("connect failed");
  });

  it("replaces bare model mentions with neutral wording", () => {
    const out = sanitizeDetail("gemini-2.5-flash-lite unavailable, retrying");
    expect(out).not.toMatch(/gemini-/i);
    expect(out).toContain("unavailable");
  });

  it("leaves ordinary messages untouched", () => {
    expect(sanitizeDetail("Microphone permission denied")).toBe("Microphone permission denied");
  });
});
