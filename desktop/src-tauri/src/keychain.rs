//! Credentials stay in the OS vault. Background reads never open a macOS
//! permission dialog; only an explicit Unlock/Save/Delete action may do that.
//! Serialize vault operations and cache both values and failures for this launch.
use keyring::Entry;
use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "com.meetingai.desktop";
const LOCKED: &str = "Saved credential needs access. Unlock it in Settings; if macOS asks, choose Always Allow to remember this app.";
type SecretResult = Result<Option<String>, String>;

#[derive(Default)]
struct SecretCache(Mutex<HashMap<String, SecretResult>>);

impl SecretCache {
    fn read(
        &self,
        key: &str,
        interactive: bool,
        read: impl FnOnce() -> SecretResult,
    ) -> SecretResult {
        let mut cache = self.0.lock().map_err(|_| "Credential cache unavailable")?;
        if let Some(value) = cache.get(key) {
            if value.is_ok() || !interactive {
                return value.clone();
            }
        }
        let value = read();
        cache.insert(key.to_string(), value.clone());
        value
    }

    fn write(
        &self,
        key: &str,
        value: Option<String>,
        write: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut cache = self.0.lock().map_err(|_| "Credential cache unavailable")?;
        write()?;
        cache.insert(key.to_string(), Ok(value));
        Ok(())
    }
}

static CACHE: std::sync::LazyLock<SecretCache> = std::sync::LazyLock::new(SecretCache::default);

fn entry(key: &str) -> Result<Entry, String> {
    if !matches!(key, "gemini_api_key" | "google_tokens") {
        return Err("Unknown MeetingAI credential".into());
    }
    Entry::new(SERVICE, key).map_err(|e| format!("Credential vault unavailable: {e}"))
}

/// Process-wide macOS interaction state must only be changed under CACHE's
/// lock. This does not bypass vault access: a denied read returns an error.
fn vault_read(key: &str, interactive: bool) -> SecretResult {
    #[cfg(target_os = "macos")]
    let _no_dialog = if interactive {
        None
    } else {
        Some(
            security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
                .map_err(|_| LOCKED.to_string())?,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let _ = interactive;
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(LOCKED.into()),
    }
}

pub(crate) fn get_secret(key: &str) -> SecretResult {
    CACHE.read(key, false, || vault_read(key, false))
}

fn write_secret(key: &str, value: &str, interactive: bool) -> Result<(), String> {
    CACHE.write(key, Some(value.to_string()), || {
        #[cfg(target_os = "macos")]
        let _no_dialog = if interactive {
            None
        } else {
            Some(
                security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
                    .map_err(|_| LOCKED.to_string())?,
            )
        };
        #[cfg(not(target_os = "macos"))]
        let _ = interactive;
        entry(key)?
            .set_password(value)
            .map_err(|_| "Could not save credential in the OS vault".into())
    })
}

pub(crate) fn set_secret(key: &str, value: &str) -> Result<(), String> {
    write_secret(key, value, true)
}

pub(crate) fn set_secret_quiet(key: &str, value: &str) -> Result<(), String> {
    write_secret(key, value, false)
}

pub(crate) fn delete_secret(key: &str) -> Result<(), String> {
    CACHE.write(key, None, || match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove credential from the OS vault".into()),
    })
}

#[tauri::command]
pub async fn keychain_get(key: String) -> SecretResult {
    tauri::async_runtime::spawn_blocking(move || get_secret(&key))
        .await
        .map_err(|e| e.to_string())?
}

/// Explicit user action. Return presence only; the secret stays in the cache.
#[tauri::command]
pub async fn keychain_unlock(key: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        CACHE
            .read(&key, true, || vault_read(&key, true))
            .map(|v| v.is_some())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn keychain_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_secret(&key, &value))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn keychain_delete(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_secret(&key))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn concurrent_reads_touch_vault_once() {
        let cache = Arc::new(SecretCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                let calls = calls.clone();
                std::thread::spawn(move || {
                    cache
                        .read("key", false, || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            Ok(Some("synthetic-secret".into()))
                        })
                        .unwrap()
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap().as_deref(), Some("synthetic-secret"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn denied_reads_are_cached_until_explicit_unlock() {
        let cache = SecretCache::default();
        assert!(cache.read("key", false, || Err(LOCKED.into())).is_err());
        assert!(cache
            .read("key", false, || panic!(
                "must not retry a denied background read"
            ))
            .is_err());
        assert_eq!(
            cache
                .read("key", true, || Ok(Some("unlocked".into())))
                .unwrap()
                .as_deref(),
            Some("unlocked")
        );
        assert!(cache
            .read("key", false, || panic!("reuse unlocked credential"))
            .is_ok());
    }

    #[test]
    fn writes_and_deletes_replace_cached_credentials_only_on_success() {
        let cache = SecretCache::default();
        cache.write("key", Some("first".into()), || Ok(())).unwrap();
        assert!(cache
            .write("key", Some("wrong".into()), || Err("denied".into()))
            .is_err());
        assert_eq!(
            cache.read("key", false, || panic!()).unwrap().as_deref(),
            Some("first")
        );
        cache.write("key", None, || Ok(())).unwrap();
        assert_eq!(cache.read("key", false, || panic!()).unwrap(), None);
    }
}
