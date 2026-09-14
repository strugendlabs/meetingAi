//! System output volume ducking (Task 7).
//!
//! Lowers the macOS output volume while translated speech plays and restores
//! it afterwards. Uses `osascript` (AppleScript `get/set volume`), which needs
//! no extra permissions. V1 scope: this *reduces* the original voice, it does
//! not fully suppress it (documented limitation).
#![allow(dead_code)]

#[cfg(target_os = "macos")]
use std::process::Command;

/// Ducked level: half the current volume with a floor of 20 — but never
/// ABOVE the current level (ducking must not raise a low or muted volume).
///
/// The master output volume also attenuates the app's OWN translated-voice
/// playback (there is no per-app volume without a virtual audio driver), so
/// the duck stays gentle and the webview compensates with a gain boost
/// (PcmPlayer.setBoost). Mirrored in TS: duckedLevel() in meetingSession.ts —
/// keep the two formulas in sync.
pub(crate) fn ducked_level(current: u8) -> u8 {
    std::cmp::min(current, std::cmp::max(20, current / 2))
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("osascript spawn error: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "osascript failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn get_output_volume() -> Result<u8, String> {
    let raw = run_osascript("output volume of (get volume settings)")?;
    raw.parse::<u8>()
        .map_err(|e| format!("unexpected volume value {raw:?}: {e}"))
}

#[cfg(target_os = "macos")]
fn set_output_volume(level: u8) -> Result<(), String> {
    let clamped = level.min(100);
    run_osascript(&format!("set volume output volume {clamped}")).map(|_| ())
}

/// Read the current output volume, duck it to `max(20, cur/2)` and return the
/// previous level so the caller can restore it later.
#[tauri::command]
pub fn duck_system_volume() -> Result<u8, String> {
    #[cfg(not(target_os = "macos"))]
    return Err("system volume ducking is currently available on macOS only".into());

    #[cfg(target_os = "macos")]
    {
        let previous = get_output_volume()?;
        set_output_volume(ducked_level(previous))?;
        Ok(previous)
    }
}

#[tauri::command]
pub fn restore_system_volume(previous: u8) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = previous;
        return Err("system volume ducking is currently available on macOS only".into());
    }

    #[cfg(target_os = "macos")]
    set_output_volume(previous)
}

#[cfg(test)]
mod tests {
    use super::ducked_level;

    #[test]
    fn ducked_level_is_half() {
        assert_eq!(ducked_level(100), 50);
        assert_eq!(ducked_level(80), 40);
        assert_eq!(ducked_level(75), 37);
    }

    #[test]
    fn ducked_level_floors_at_twenty_for_louder_volumes() {
        assert_eq!(ducked_level(21), 20);
        assert_eq!(ducked_level(39), 20);
        assert_eq!(ducked_level(40), 20);
        assert_eq!(ducked_level(41), 20);
        assert_eq!(ducked_level(42), 21);
    }

    #[test]
    fn ducked_level_never_raises_a_low_volume() {
        assert_eq!(ducked_level(0), 0);
        assert_eq!(ducked_level(5), 5);
        assert_eq!(ducked_level(10), 10);
        assert_eq!(ducked_level(20), 20);
    }
}
