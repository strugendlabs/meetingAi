//! Google OAuth 2.0 PKCE + localhost loopback flow (Task 7).
//!
//! Flow: generate PKCE verifier/challenge (S256) → start `tiny_http` server on
//! an ephemeral 127.0.0.1 port → open the Google consent URL in the default
//! browser (opener plugin) → catch the redirect, verify `state`, show a
//! success page → exchange the code at `https://oauth2.googleapis.com/token`
//! → persist tokens in the Keychain under `google_tokens`.
#![allow(dead_code)]

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Append a diagnostic line to the platform's MeetingAI log directory. The OAuth
/// flow is interactive and can't be reproduced headlessly, so each step is
/// recorded here — when a user reports "sign-in doesn't work", this file tells
/// us exactly where it broke (port bound, redirect received, token-exchange
/// status, …). NEVER logs secrets: no tokens, no auth code, no client secret —
/// only ports, HTTP status codes, and Google's own error strings.
pub(crate) fn oauth_log(msg: &str) {
    #[cfg(target_os = "macos")]
    let dir = {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        std::path::Path::new(&home).join("Library/Logs/MeetingAI")
    };
    #[cfg(windows)]
    let dir = {
        let Ok(local_app_data) = std::env::var("LOCALAPPDATA") else {
            return;
        };
        std::path::Path::new(&local_app_data).join("MeetingAI/logs")
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let dir = {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        std::path::Path::new(&home).join(".local/state/meetingai")
    };
    let _ = std::fs::create_dir_all(&dir);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("oauth.log"))
    {
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPES: &str = "openid email profile https://www.googleapis.com/auth/calendar.readonly";
const TOKENS_KEYCHAIN_KEY: &str = "google_tokens";
const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(180);

/// Preferred loopback ports, tried in order, so the redirect URI is STABLE
/// across sign-ins: `http://127.0.0.1:51739` (then :51740, :51741 when taken).
/// A stable URI lets "Web application"-type OAuth clients pre-register it —
/// they reject unlisted redirects with redirect_uri_mismatch. "Desktop app"
/// clients accept any 127.0.0.1 port, so the ephemeral fallback below only
/// matters when all three ports are occupied.
pub(crate) const PREFERRED_LOOPBACK_PORTS: [u16; 3] = [51739, 51740, 51741];

/// Bumped by every `google_oauth_start` call. A pending loopback wait aborts
/// as soon as it sees this move past its own generation. Without this, an
/// abandoned attempt — most notably one where Google rejects the redirect
/// before ever calling back (e.g. redirect_uri_mismatch shows Google's own
/// error page directly) — sits on its port for the full `LOOPBACK_TIMEOUT`.
/// A retry within that window would then get pushed onto a non-preferred, or
/// even ephemeral, port that was never registered in Google Cloud Console —
/// defeating the whole point of the stable preferred-port list.
static ATTEMPT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// How often the loopback wait re-checks `ATTEMPT_GENERATION` / the deadline,
/// and how long a fresh bind retries a preferred port before falling back to
/// an ephemeral one — giving a just-superseded attempt time to notice and
/// release it.
const POLL_INTERVAL: Duration = Duration::from_millis(200);
const BIND_RETRY_WINDOW: Duration = Duration::from_secs(1);

/// Bind the loopback server: preferred ports first, ephemeral as last resort.
/// Retries the preferred ports for `BIND_RETRY_WINDOW` — long enough for a
/// just-superseded attempt (see `ATTEMPT_GENERATION`) to release one.
fn bind_loopback_server() -> Result<(tiny_http::Server, u16), String> {
    let retry_deadline = std::time::Instant::now() + BIND_RETRY_WINDOW;
    loop {
        for port in PREFERRED_LOOPBACK_PORTS {
            if let Ok(server) = tiny_http::Server::http(("127.0.0.1", port)) {
                return Ok((server, port));
            }
        }
        if std::time::Instant::now() >= retry_deadline {
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("could not start loopback server: {e}"))?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        #[cfg(unix)]
        _ => return Err("loopback server bound to a non-IP address".to_string()),
    };
    Ok((server, port))
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

/// 64 random bytes, base64url (no padding) → 86-char verifier (43..=128 valid).
pub(crate) fn pkce_verifier() -> String {
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// S256 challenge: BASE64URL-ENCODE(SHA256(ASCII(verifier))), no padding.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

pub(crate) fn random_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Build the Google consent-screen URL.
pub(crate) fn build_auth_url(
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> String {
    let mut u = url::Url::parse(AUTH_ENDPOINT).expect("static auth endpoint is valid");
    u.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", state);
    u.to_string()
}

// ---------------------------------------------------------------------------
// Token payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub email: String,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Extract `email` from an OIDC id_token (JWT) without signature verification —
/// the token came straight from Google over TLS in our own code exchange.
fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("email")?.as_str().map(str::to_owned)
}

// ---------------------------------------------------------------------------
// Loopback redirect handling
// ---------------------------------------------------------------------------

const SUCCESS_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>MeetingAI</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0d10;color:#f5f5f7}div{text-align:center}h1{font-size:1.5rem}p{color:#9a9aa2}</style>
</head><body><div><h1>Signed in to MeetingAI</h1><p>You can close this tab and return to the app.</p></div></body></html>"#;

const FAILURE_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>MeetingAI</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0d10;color:#f5f5f7}div{text-align:center}h1{font-size:1.5rem}p{color:#9a9aa2}</style>
</head><body><div><h1>Sign-in failed</h1><p>You can close this tab and try again in the app.</p></div></body></html>"#;

fn html_response(body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let header =
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
            .expect("static header is valid");
    tiny_http::Response::from_string(body).with_header(header)
}

/// Parse `code`/`state`/`error` out of the redirect request path.
pub(crate) fn parse_redirect_query(
    path_and_query: &str,
) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let u = url::Url::parse(&format!("http://127.0.0.1{path_and_query}")).ok()?;
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    Some((code, state, error))
}

/// Block until the browser hits the loopback server with a code (or error).
/// Ignores unrelated requests (e.g. /favicon.ico). Polls in `POLL_INTERVAL`
/// ticks (rather than blocking for the whole remaining timeout in one call)
/// so a newer `google_oauth_start` invocation can supersede this one and
/// free its port promptly instead of holding it for the full timeout.
fn wait_for_redirect(
    server: &tiny_http::Server,
    expected_state: String,
    my_generation: u64,
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + LOOPBACK_TIMEOUT;
    loop {
        if ATTEMPT_GENERATION.load(Ordering::SeqCst) != my_generation {
            return Err("OAuth sign-in was superseded by a newer attempt".to_string());
        }
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| "OAuth timed out waiting for the browser redirect".to_string())?;
        let request = match server.recv_timeout(remaining.min(POLL_INTERVAL)) {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(e) => return Err(format!("loopback server error: {e}")),
        };

        let parsed = parse_redirect_query(request.url());
        match parsed {
            Some((Some(code), state, None)) => {
                if state.as_deref() != Some(expected_state.as_str()) {
                    oauth_log("redirect received but state mismatch (possible CSRF)");
                    let _ = request.respond(html_response(FAILURE_HTML));
                    return Err("OAuth state mismatch — possible CSRF, aborting".to_string());
                }
                let _ = request.respond(html_response(SUCCESS_HTML));
                return Ok(code);
            }
            Some((_, _, Some(err))) => {
                oauth_log(&format!("redirect carried an OAuth error: {err}"));
                let _ = request.respond(html_response(FAILURE_HTML));
                return Err(format!("OAuth error from Google: {err}"));
            }
            _ => {
                // Unrelated request (favicon etc.) — 404 and keep waiting.
                let _ = request
                    .respond(tiny_http::Response::from_string("Not found").with_status_code(404));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Run the full PKCE loopback flow. Returns JSON
/// `{access_token, refresh_token, expires_at, email}` and stores the same
/// object in the Keychain under `google_tokens`.
#[tauri::command]
pub async fn google_oauth_start(
    app: AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<String, String> {
    if client_id.trim().is_empty() {
        return Err("Google OAuth client ID is not configured".to_string());
    }

    let verifier = pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let state = random_state();

    oauth_log(&format!(
        "start: client_id ends …{}, secret {}",
        client_id
            .chars()
            .rev()
            .take(14)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>(),
        if client_secret.trim().is_empty() {
            "EMPTY"
        } else {
            "present"
        },
    ));

    // Supersede any still-pending attempt (e.g. abandoned after Google
    // rejected the redirect before ever calling back) so it releases its
    // port promptly instead of starving this one off the preferred ports.
    let my_generation = ATTEMPT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (server, port) = bind_loopback_server()?;
    let redirect_uri = format!("http://127.0.0.1:{port}");
    oauth_log(&format!(
        "bound loopback port {port}, redirect_uri={redirect_uri}"
    ));

    let auth_url = build_auth_url(&client_id, &redirect_uri, &challenge, &state);
    app.opener().open_url(auth_url, None::<&str>).map_err(|e| {
        oauth_log(&format!("open browser FAILED: {e}"));
        format!("could not open browser: {e}")
    })?;
    oauth_log("opened consent URL in browser; waiting for redirect…");

    // tiny_http is blocking — wait on a blocking thread, not a runtime worker.
    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_redirect(&server, state, my_generation)
    })
    .await
    .map_err(|e| format!("loopback task failed: {e}"))?
    .inspect_err(|e| oauth_log(&format!("redirect wait ended without a code: {e}")))?;
    oauth_log("received authorization code from redirect");

    // Exchange the authorization code for tokens.
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("token exchange request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("token exchange read failed: {e}"))?;
    if !status.is_success() {
        // Body is a Google OAuth error object (e.g. {"error":"invalid_grant"}) —
        // safe to log, contains no secret.
        oauth_log(&format!("token exchange FAILED ({status}): {body}"));
        return Err(format!("token exchange failed ({status}): {body}"));
    }
    oauth_log("token exchange OK");
    let tokens: TokenResponse =
        serde_json::from_str(&body).map_err(|e| format!("bad token response: {e}"))?;

    let email = match tokens.id_token.as_deref().and_then(email_from_id_token) {
        Some(e) => e,
        None => fetch_userinfo_email(&client, &tokens.access_token)
            .await
            .unwrap_or_default(),
    };

    let has_refresh = tokens.refresh_token.is_some();
    let stored = StoredTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token.unwrap_or_default(),
        expires_at: now_unix() + tokens.expires_in.unwrap_or(3600),
        email: email.clone(),
    };
    let json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
    crate::keychain::set_secret(TOKENS_KEYCHAIN_KEY, &json)?;
    oauth_log(&format!(
        "SUCCESS: signed in as {}, refresh_token {}",
        if email.is_empty() {
            "<no email>"
        } else {
            &email
        },
        if has_refresh { "received" } else { "MISSING" },
    ));
    Ok(json)
}

/// Refresh the access token. Returns the updated stored-tokens JSON and
/// rewrites the Keychain entry (refresh_token/email carried over).
#[tauri::command]
pub async fn google_oauth_refresh(
    client_id: String,
    client_secret: String,
    refresh_token: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("token refresh request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("token refresh read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("token refresh failed ({status}): {body}"));
    }
    let tokens: TokenResponse =
        serde_json::from_str(&body).map_err(|e| format!("bad refresh response: {e}"))?;

    // Carry forward email / refresh_token from the stored entry when absent.
    let existing: Option<StoredTokens> = crate::keychain::get_secret(TOKENS_KEYCHAIN_KEY)?
        .and_then(|s| serde_json::from_str(&s).ok());
    let stored = StoredTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token.unwrap_or(refresh_token),
        expires_at: now_unix() + tokens.expires_in.unwrap_or(3600),
        email: existing.map(|e| e.email).unwrap_or_default(),
    };
    let json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
    crate::keychain::set_secret_quiet(TOKENS_KEYCHAIN_KEY, &json)?;
    Ok(json)
}

async fn fetch_userinfo_email(client: &reqwest::Client, access_token: &str) -> Option<String> {
    let v: serde_json::Value = client
        .get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v.get("email")?.as_str().map(str::to_owned)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn loopback_binds_preferred_port_then_next_when_taken() {
        let (first, p1) = bind_loopback_server().expect("first bind");
        assert_eq!(p1, PREFERRED_LOOPBACK_PORTS[0]);
        let (second, p2) = bind_loopback_server().expect("second bind");
        assert_eq!(p2, PREFERRED_LOOPBACK_PORTS[1]);

        // Regression: a superseded attempt's port frees up mid-retry (e.g. its
        // wait_for_redirect loop noticed ATTEMPT_GENERATION moved on and
        // dropped its server) — bind_loopback_server should recover it rather
        // than immediately falling back to an ephemeral, unregistered port.
        // `first`/`second` stay bound throughout so only the third port is a
        // candidate, and this test owns the whole preferred-port range so it
        // can't collide with other tests running in parallel.
        let releaser = std::thread::spawn(|| {
            let stale = tiny_http::Server::http(("127.0.0.1", PREFERRED_LOOPBACK_PORTS[2]))
                .expect("stale bind");
            std::thread::sleep(Duration::from_millis(150));
            drop(stale);
        });
        std::thread::sleep(Duration::from_millis(20)); // let the port become busy first
        let (third, p3) = bind_loopback_server().expect("third bind recovers freed port");
        assert_eq!(p3, PREFERRED_LOOPBACK_PORTS[2]);
        releaser.join().expect("releaser thread");
        drop((first, second, third));
    }

    #[test]
    fn wait_for_redirect_aborts_promptly_when_superseded() {
        // Bind on an ephemeral port (not one of the preferred ones) so this
        // test can't collide with loopback_binds_preferred_port_then_next_when_taken.
        let server = tiny_http::Server::http("127.0.0.1:0").expect("ephemeral bind");
        let my_generation = ATTEMPT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        // Simulate a newer google_oauth_start call starting right after.
        ATTEMPT_GENERATION.fetch_add(1, Ordering::SeqCst);

        let start = std::time::Instant::now();
        let result = wait_for_redirect(&server, "state".to_string(), my_generation);
        let elapsed = start.elapsed();

        let err = result.expect_err("superseded attempt must not succeed");
        assert!(err.contains("superseded"), "unexpected error: {err}");
        // Must abort within a poll tick or two, not sit for LOOPBACK_TIMEOUT (180s).
        assert!(
            elapsed < Duration::from_secs(2),
            "took too long: {elapsed:?}"
        );
        // Measure cancellation separately from tiny_http's destructor, which
        // makes a blocking TCP connection to wake its listener on Windows.
        drop(server);
    }

    #[test]
    fn verifier_length_and_charset_are_rfc7636_valid() {
        let v = pkce_verifier();
        // RFC 7636 §4.1: 43..=128 chars from [A-Za-z0-9-._~]; base64url yields [A-Za-z0-9-_].
        assert!(
            (43..=128).contains(&v.len()),
            "verifier length {} out of range",
            v.len()
        );
        assert!(v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn verifier_is_random() {
        assert_ne!(pkce_verifier(), pkce_verifier());
    }

    #[test]
    fn challenge_matches_rfc7636_test_vector() {
        // Appendix B of RFC 7636.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn challenge_is_unpadded_base64url_of_sha256() {
        let c = pkce_challenge(&pkce_verifier());
        assert_eq!(c.len(), 43); // 32 bytes → 43 base64url chars, no '='
        assert!(!c.contains('='));
    }

    #[test]
    fn auth_url_has_all_required_params() {
        let url_str = build_auth_url(
            "client-123.apps.googleusercontent.com",
            "http://127.0.0.1:49152",
            "test-challenge",
            "test-state",
        );
        let u = url::Url::parse(&url_str).expect("auth url parses");
        assert_eq!(u.host_str(), Some("accounts.google.com"));
        assert_eq!(u.path(), "/o/oauth2/v2/auth");

        let q: HashMap<String, String> = u
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(
            q.get("client_id").map(String::as_str),
            Some("client-123.apps.googleusercontent.com")
        );
        assert_eq!(
            q.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:49152")
        );
        assert_eq!(q.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(
            q.get("code_challenge").map(String::as_str),
            Some("test-challenge")
        );
        assert_eq!(
            q.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(q.get("access_type").map(String::as_str), Some("offline"));
        assert_eq!(q.get("prompt").map(String::as_str), Some("consent"));
        assert_eq!(q.get("state").map(String::as_str), Some("test-state"));
        let scope = q.get("scope").expect("scope present");
        assert!(scope.contains("openid"));
        assert!(scope.contains("email"));
        assert!(scope.contains("profile"));
        assert!(scope.contains("https://www.googleapis.com/auth/calendar.readonly"));
    }

    #[test]
    fn parse_redirect_query_extracts_code_and_state() {
        let (code, state, error) =
            parse_redirect_query("/?state=abc&code=4%2F0Axyz&scope=openid").unwrap();
        assert_eq!(code.as_deref(), Some("4/0Axyz"));
        assert_eq!(state.as_deref(), Some("abc"));
        assert!(error.is_none());
    }

    #[test]
    fn parse_redirect_query_extracts_error() {
        let (code, _, error) = parse_redirect_query("/?error=access_denied&state=abc").unwrap();
        assert!(code.is_none());
        assert_eq!(error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn email_extracted_from_unsigned_jwt() {
        // header.payload.sig with payload {"email":"a@b.co"}
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"email":"a@b.co","sub":"1"}"#);
        let jwt = format!("{header}.{payload}.sig");
        assert_eq!(email_from_id_token(&jwt).as_deref(), Some("a@b.co"));
        assert!(email_from_id_token("garbage").is_none());
    }
}
