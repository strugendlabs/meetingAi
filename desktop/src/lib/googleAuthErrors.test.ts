import { describe, expect, it } from "vitest";
import { describeGoogleAuthError } from "./googleAuthErrors";

describe("describeGoogleAuthError", () => {
  it("explains redirect_uri_mismatch from a token-exchange failure body", () => {
    const raw =
      'token exchange failed (400): {"error":"redirect_uri_mismatch","error_description":"Bad Request: both redirect_uri and the registered..."}';
    const result = describeGoogleAuthError(raw);
    expect(result).toContain("doesn't allow this app's sign-in address");
    expect(result).toContain("51739");
    expect(result).toContain("51740");
    expect(result).toContain("51741");
    expect(result).toContain("Desktop app client type");
  });

  it("explains redirect_uri_mismatch from a token-refresh failure body", () => {
    const raw = 'token refresh failed (400): {"error":"redirect_uri_mismatch","error_description":"..."}';
    expect(describeGoogleAuthError(raw)).toContain("doesn't allow this app's sign-in address");
  });

  it("explains access_denied surfaced via the loopback redirect", () => {
    const raw = "OAuth error from Google: access_denied";
    const result = describeGoogleAuthError(raw);
    expect(result).toContain("cancelled");
    expect(result).toContain("test user");
  });

  it("explains access_denied surfaced via a token-exchange JSON body", () => {
    const raw = 'token exchange failed (400): {"error":"access_denied","error_description":"..."}';
    expect(describeGoogleAuthError(raw)).toContain("test user");
  });

  it("explains invalid_client", () => {
    const raw = 'token exchange failed (401): {"error":"invalid_client","error_description":"..."}';
    const result = describeGoogleAuthError(raw);
    expect(result).toContain("Client ID or Secret is incorrect");
    expect(result).toContain("Settings");
  });

  it("explains a superseded sign-in attempt", () => {
    const raw = "OAuth sign-in was superseded by a newer attempt";
    expect(describeGoogleAuthError(raw)).toContain("replaced by a newer one");
  });

  it("explains a loopback timeout with the likely test-user cause", () => {
    const raw = "OAuth timed out waiting for the browser redirect";
    const msg = describeGoogleAuthError(raw);
    expect(msg).toMatch(/test user/i);
    expect(msg).toMatch(/access blocked|isn't verified/i);
  });

  it("falls back to the raw message for unrecognized errors", () => {
    const raw = "could not open browser: no default handler configured";
    expect(describeGoogleAuthError(raw)).toBe(raw);
  });

  it("falls back to the raw message for an unrecognized Google error code", () => {
    const raw = 'token exchange failed (400): {"error":"invalid_grant","error_description":"..."}';
    expect(describeGoogleAuthError(raw)).toBe(raw);
  });

  it("never hides the original text for a fallback case", () => {
    const raw = "Google OAuth client ID is not configured";
    expect(describeGoogleAuthError(raw)).toBe(raw);
  });
});
