//! Native credential-vault access via the `keyring` crate (Task 7).
//!
//! Service: `com.meetingai.desktop`. Secrets (Gemini API key, Google OAuth
//! tokens) live here — never in SQLite, localStorage or logs.
//!
//! A process-lifetime in-memory cache fronts every read: the UI reads the API
//! key on each meeting start and the Settings/Calendar screens read on mount,
//! so without the cache macOS can repeatedly show the Keychain access panel.
//! Each secret hits the platform credential vault at most once per app launch.
//! Writes and deletes keep the cache coherent so a key the user just changed
//! is never served stale.
#![allow(dead_code)]

use keyring::Entry;
use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "com.meetingai.desktop";

/// key -> Some(value) present, None known-absent. Absence from the map means
/// "not yet read" (distinct from a cached None).
static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

fn cache_get(key: &str) -> Option<Option<String>> {
    let guard = CACHE.lock().ok()?;
    guard.as_ref()?.get(key).cloned()
}

fn cache_put(key: &str, value: Option<String>) {
    if let Ok(mut guard) = CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(key.to_string(), value);
    }
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("keychain entry error: {e}"))
}

/// Internal helper (also used by `oauth.rs` to persist Google tokens).
pub(crate) fn set_secret(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("keychain set error: {e}"))?;
    cache_put(key, Some(value.to_string()));
    Ok(())
}

/// Internal helper. `Ok(None)` when the key does not exist. Served from the
/// in-memory cache after the first real read (see module docs).
pub(crate) fn get_secret(key: &str) -> Result<Option<String>, String> {
    if let Some(cached) = cache_get(key) {
        return Ok(cached);
    }
    let value = match entry(key)?.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(format!("keychain get error: {e}")),
    };
    cache_put(key, value.clone());
    Ok(value)
}

/// Internal helper. Deleting a missing key is not an error.
pub(crate) fn delete_secret(key: &str) -> Result<(), String> {
    let result = match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete error: {e}")),
    };
    // Reflect the deletion in the cache regardless of the keyring outcome for
    // the missing-key case; on a real error leave the cache untouched.
    if result.is_ok() {
        cache_put(key, None);
    }
    result
}

#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    set_secret(&key, &value)
}

#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    get_secret(&key)
}

#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    delete_secret(&key)
}
