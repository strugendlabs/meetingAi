//! System-audio sidecar bridge (Task 4).
//!
//! Spawns the platform-native `system-audio` sidecar (Swift/ScreenCaptureKit
//! on macOS, C++/WASAPI on Windows), parses its length-prefixed PCM16 frames
//! and re-emits them to the frontend as Tauri events.
//!
//! Sidecar contract:
//! - stdout: frames of raw PCM16 LE mono 16 kHz, length-prefixed `[u32 LE byte-length][payload]`
//! - stderr: JSON status lines: `{"event":"started"}` / `{"event":"error","message":"..."}`
//! - `--check` flag: exit 0 if capture permission is granted, 2 if TCC denied
//!
//! Events emitted to the frontend:
//! - `system-audio-chunk` `{ data: <base64 pcm16> }`
//! - `system-audio-error` `{ message: <string> }`

// Commands are registered in lib.rs in Task 11; until then this module is
// intentionally unused.
#![allow(dead_code)]

use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Upper bound on a single frame; anything larger means a corrupt stream.
/// (Real frames are ~8 KB: 250 ms of 16 kHz PCM16.)
const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

/// A running sidecar plus the spawn generation it belongs to. The generation
/// lets the stdout-reader thread tell "my child is still the registered one"
/// (unexpected death → report it) apart from "a stop or restart already claimed
/// it" (stay silent).
struct SidecarState {
    generation: u64,
    child: Child,
}

static SIDECAR: Mutex<Option<SidecarState>> = Mutex::new(None);

/// Monotonic id for successive sidecar spawns; see [`SidecarState`].
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, serde::Serialize)]
struct ChunkPayload {
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct ErrorPayload {
    message: String,
}

enum HeaderRead {
    Eof,
    Full,
}

/// Fills `buf` completely, or reports a clean EOF if the stream ended exactly
/// at a frame boundary (zero bytes read).
fn read_header<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<HeaderRead> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(HeaderRead::Eof);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated frame header",
                ));
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(HeaderRead::Full)
}

/// Parses the sidecar's length-prefixed frame stream (`[u32 LE length][payload]`)
/// until EOF, invoking `on_frame` for every payload. Returns `Ok(())` on a clean
/// EOF at a frame boundary, `Err` on truncation or a corrupt length prefix.
fn read_frames<R: Read>(mut reader: R, mut on_frame: impl FnMut(&[u8])) -> io::Result<()> {
    let mut len_buf = [0u8; 4];
    loop {
        match read_header(&mut reader, &mut len_buf)? {
            HeaderRead::Eof => return Ok(()),
            HeaderRead::Full => {}
        }
        let len = u32::from_le_bytes(len_buf);
        if len == 0 {
            continue;
        }
        if len > MAX_FRAME_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("frame length {len} exceeds maximum {MAX_FRAME_LEN}"),
            ));
        }
        let mut payload = vec![0u8; len as usize];
        reader.read_exact(&mut payload)?;
        on_frame(&payload);
    }
}

/// Removes and returns the registered child if it still belongs to
/// `generation`. Returns `None` when a stop/restart already claimed the slot
/// (or replaced it with a newer generation) — in that case the caller must not
/// report the exit, because someone else owns the outcome.
fn take_child_if_current(slot: &Mutex<Option<SidecarState>>, generation: u64) -> Option<Child> {
    let mut guard = slot.lock().ok()?;
    if guard.as_ref().is_some_and(|s| s.generation == generation) {
        guard.take().map(|s| s.child)
    } else {
        None
    }
}

/// Reaps a sidecar whose stdout stream has ended. The child normally exits
/// right after closing stdout, so poll briefly for its real exit status;
/// if it lingers with a closed audio stream it is useless — kill it.
/// Returns the child's own exit status when it exited by itself.
fn reap_child(mut child: Child) -> Option<ExitStatus> {
    for _ in 0..50 {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

/// Message for a sidecar that ended its stream without a stop being requested.
/// Deliberately starts with "sidecar exited" so the frontend can tell it apart
/// from `sidecar stream error: …` (corrupt stream) and from sidecar-reported
/// JSON errors.
fn sidecar_exit_message(status: Option<ExitStatus>) -> String {
    match status {
        Some(status) => format!("sidecar exited unexpectedly ({status})"),
        None => "sidecar exited unexpectedly (audio stream closed)".to_string(),
    }
}

#[derive(Default)]
struct CaptureReport {
    started: bool,
    error: Option<String>,
    error_emitted: bool,
}

/// Drain stderr before choosing an exit message: stdout EOF can arrive before
/// the reader has parsed the actual permission/device failure on stderr.
fn read_capture_status(
    reader: impl BufRead,
    startup: &mpsc::SyncSender<Result<(), String>>,
    mut on_error: impl FnMut(&str) -> bool,
) -> CaptureReport {
    let mut report = CaptureReport::default();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match value.get("event").and_then(|e| e.as_str()) {
            Some("started") if !report.started && report.error.is_none() => {
                report.started = true;
                let _ = startup.try_send(Ok(()));
            }
            Some("error") => {
                let message = value
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Call audio capture failed")
                    .to_string();
                if report.started {
                    report.error_emitted = on_error(&message);
                } else {
                    let _ = startup.try_send(Err(message.clone()));
                }
                report.error = Some(message);
            }
            _ => {}
        }
    }
    report
}

fn capture_failure(
    report: &CaptureReport,
    result: io::Result<()>,
    status: Option<ExitStatus>,
) -> String {
    if let Some(message) = &report.error {
        return message.clone();
    }
    match result {
        Err(e) => format!("Call audio stream failed: {e}"),
        Ok(()) => sidecar_exit_message(status),
    }
}

fn emit_capture_error(app: &AppHandle, generation: u64, message: &str) -> bool {
    // Serialize with stop/retry so an old helper cannot poison a new capture.
    let Ok(guard) = SIDECAR.lock() else {
        return false;
    };
    if !guard.as_ref().is_some_and(|s| s.generation == generation) {
        return false;
    }
    let _ = app.emit(
        "system-audio-error",
        ErrorPayload {
            message: message.to_string(),
        },
    );
    true
}

/// Resolves the sidecar binary: next to the app executable when bundled
/// (Tauri strips the target-triple suffix), falling back to the dev-time
/// `src-tauri/binaries/` location.
fn sidecar_path() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            #[cfg(target_os = "macos")]
            const BUNDLED_NAMES: &[&str] = &["system-audio", "system-audio-aarch64-apple-darwin"];
            #[cfg(windows)]
            const BUNDLED_NAMES: &[&str] = &[
                "system-audio.exe",
                "system-audio-x86_64-pc-windows-msvc.exe",
            ];
            #[cfg(not(any(target_os = "macos", windows)))]
            const BUNDLED_NAMES: &[&str] = &["system-audio"];

            for name in BUNDLED_NAMES {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    const DEV_NAME: &str = "system-audio-aarch64-apple-darwin";
    #[cfg(windows)]
    const DEV_NAME: &str = "system-audio-x86_64-pc-windows-msvc.exe";
    #[cfg(not(any(target_os = "macos", windows)))]
    const DEV_NAME: &str = "system-audio";

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(DEV_NAME);
    if dev.is_file() {
        return Ok(dev);
    }
    Err("system-audio sidecar binary not found".into())
}

/// Constructs a sidecar command without opening a visible console window on
/// Windows. The main Tauri executable uses the GUI subsystem, so an ordinary
/// console-subsystem child would otherwise flash a terminal at every meeting.
#[cfg(windows)]
fn sidecar_command(path: &PathBuf) -> Command {
    let mut command = Command::new(path);
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
        .arg("--exclude-pid")
        .arg(std::process::id().to_string());
    command
}

#[cfg(not(windows))]
fn sidecar_command(path: &PathBuf) -> Command {
    Command::new(path)
}

/// Spawns the sidecar and streams its PCM frames to the frontend as
/// `system-audio-chunk` events; sidecar errors surface as `system-audio-error`.
#[tauri::command]
pub async fn start_system_capture(app: AppHandle) -> Result<(), String> {
    let (generation, ready) = spawn_system_capture(app)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        ready.recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| Err("Call audio did not start. Check recording permission and your output device, then retry audio.".into()))
    }).await.map_err(|e| e.to_string())?;
    if result.is_err() {
        if let Some(mut child) = take_child_if_current(&SIDECAR, generation) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    result
}

fn spawn_system_capture(
    app: AppHandle,
) -> Result<(u64, mpsc::Receiver<Result<(), String>>), String> {
    let mut guard = SIDECAR.lock().map_err(|e| e.to_string())?;
    if let Some(state) = guard.as_mut() {
        match state.child.try_wait() {
            Ok(Some(_)) => *guard = None, // previous sidecar died; respawn
            Ok(None) => return Err("system audio capture already running".into()),
            Err(e) => return Err(e.to_string()),
        }
    }

    let path = sidecar_path()?;
    let mut child = sidecar_command(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "sidecar stderr unavailable".to_string())?;
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    *guard = Some(SidecarState { generation, child });
    drop(guard);

    let (startup, ready) = mpsc::sync_channel(1);
    let (report_tx, report_rx) = mpsc::sync_channel(1);
    let app_status = app.clone();
    let startup_status = startup.clone();
    std::thread::spawn(move || {
        let report = read_capture_status(BufReader::new(stderr), &startup_status, |message| {
            emit_capture_error(&app_status, generation, message)
        });
        let _ = report_tx.send(report);
    });

    let app_frames = app.clone();
    std::thread::spawn(move || {
        let result = read_frames(stdout, |payload| {
            let _ = app_frames.emit(
                "system-audio-chunk",
                ChunkPayload {
                    data: B64.encode(payload),
                },
            );
        });
        // The reader loop ended: either the stream broke (Err) or the sidecar
        // closed stdout (clean EOF). Both mean capture is over. If our
        // generation is still registered, no stop/restart claimed the child:
        // clear the slot (so the next start_system_capture succeeds), reap the
        // child, and surface the failure. If it was already claimed, a
        // stop_system_capture or respawn owns the outcome — stay silent.
        let reaped = take_child_if_current(&SIDECAR, generation).map(reap_child);
        // The process has been reaped, so stderr should close promptly. Bound
        // the wait in case a broken helper left an inherited pipe open.
        let report = report_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap_or_default();
        if let Some(status) = reaped {
            let message = capture_failure(&report, result, status);
            let _ = startup.try_send(Err(message.clone()));
            // A startup failure is returned by the command. After startup,
            // preserve any specific error already delivered; never overwrite
            // it with the process exit code from the other pipe.
            if report.started && !report.error_emitted {
                let guard = SIDECAR.lock().unwrap();
                if guard.is_none() && NEXT_GENERATION.load(Ordering::Relaxed) == generation + 1 {
                    let _ = app_frames.emit("system-audio-error", ErrorPayload { message });
                }
            }
        } else {
            let _ = startup.try_send(Err("Call audio capture was stopped".into()));
        }
    });

    Ok((generation, ready))
}

/// Only fixed OS destinations are accepted; no arbitrary shell command or URL.
#[tauri::command]
pub async fn open_audio_settings(source: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let (program, destination) = (
        "open",
        match source.as_str() {
            "system" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "input" => "x-apple.systempreferences:com.apple.preference.sound?input",
            _ => return Err("Unknown audio settings page".into()),
        },
    );
    #[cfg(windows)]
    let (program, destination) = (
        "explorer.exe",
        match source.as_str() {
            "microphone" => "ms-settings:privacy-microphone",
            "system" | "input" => "ms-settings:sound",
            _ => return Err("Unknown audio settings page".into()),
        },
    );
    #[cfg(not(any(target_os = "macos", windows)))]
    return Err("Open your system audio settings to change recording access".into());
    #[cfg(any(target_os = "macos", windows))]
    {
        Command::new(program)
            .arg(destination)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Kills the sidecar if it is running. Idempotent.
///
/// Takes the child out of `SIDECAR` *before* killing it, so the reader thread
/// (which only reports exits for a still-registered generation) treats the
/// resulting EOF as a requested stop, not an unexpected death.
#[tauri::command]
pub async fn stop_system_capture() -> Result<(), String> {
    let mut guard = SIDECAR.lock().map_err(|e| e.to_string())?;
    if let Some(state) = guard.take() {
        let mut child = state.child;
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

/// Runs `system-audio --check`: exit 0 means capture is available; exit 2 is
/// the macOS TCC-denied result. Windows has no equivalent user permission, so
/// its check validates that WASAPI loopback can initialize.
#[tauri::command]
pub async fn check_system_audio_permission(_app: AppHandle) -> Result<bool, String> {
    let path = sidecar_path()?;
    let status = tauri::async_runtime::spawn_blocking(move || {
        let mut command = sidecar_command(&path);
        command
            .arg("--check")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("failed to run sidecar --check: {e}"))?;

    match status.code() {
        Some(0) => Ok(true),
        Some(2) => Ok(false),
        other => Err(format!("sidecar --check exited unexpectedly: {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[cfg(unix)]
    #[test]
    fn permission_error_survives_stdout_eof_before_stderr() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("exec 1>&-; sleep 0.03; printf '%s\\n' '{\"event\":\"error\",\"message\":\"Screen recording permission denied\"}' >&2; exit 2")
            .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (startup, ready) = mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            read_capture_status(BufReader::new(stderr), &startup, |_| {
                panic!(
                    "Startup errors must be returned to the caller, not emitted as runtime errors"
                )
            })
        });
        let result = read_frames(stdout, |_| panic!("No audio was captured"));
        let status = reap_child(child);
        let report = reader.join().unwrap();
        assert!(!report.started);
        assert_eq!(
            ready.recv().unwrap(),
            Err("Screen recording permission denied".into())
        );
        assert_eq!(
            capture_failure(&report, result, status),
            "Screen recording permission denied"
        );
    }

    #[test]
    fn runtime_error_keeps_the_specific_reason_and_marks_it_delivered() {
        let (startup, ready) = mpsc::sync_channel(1);
        let mut errors = Vec::new();
        let report = read_capture_status(Cursor::new(
            "{\"event\":\"started\"}\n{\"event\":\"error\",\"message\":\"Output device disconnected\"}\n"
        ), &startup, |message| { errors.push(message.to_string()); true });
        assert_eq!(ready.recv().unwrap(), Ok(()));
        assert_eq!(errors, ["Output device disconnected"]);
        assert!(report.error_emitted);
        assert_eq!(
            capture_failure(&report, Ok(()), None),
            "Output device disconnected"
        );
    }

    #[test]
    fn noise_or_warning_is_not_successful_startup() {
        let (startup, ready) = mpsc::sync_channel(1);
        let report = read_capture_status(
            Cursor::new(
                "native diagnostic\n{\"event\":\"warning\",\"message\":\"still starting\"}\n",
            ),
            &startup,
            |_| true,
        );
        assert!(!report.started);
        assert!(matches!(ready.try_recv(), Err(mpsc::TryRecvError::Empty)));
    }

    fn frame(payload: &[u8]) -> Vec<u8> {
        let mut out = (payload.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(payload);
        out
    }

    fn collect(stream: &[u8]) -> io::Result<Vec<Vec<u8>>> {
        let mut frames = Vec::new();
        read_frames(Cursor::new(stream), |p| frames.push(p.to_vec()))?;
        Ok(frames)
    }

    #[test]
    fn parses_multiple_frames() {
        let mut stream = frame(&[1, 2, 3, 4]);
        stream.extend(frame(&[0xAA; 8000])); // ~250ms of 16k PCM16
        stream.extend(frame(&[9]));
        let frames = collect(&stream).expect("clean stream parses");
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0], vec![1, 2, 3, 4]);
        assert_eq!(frames[1].len(), 8000);
        assert_eq!(frames[2], vec![9]);
    }

    #[test]
    fn empty_stream_is_clean_eof() {
        assert!(collect(&[]).expect("empty stream is ok").is_empty());
    }

    #[test]
    fn zero_length_frames_are_skipped() {
        let mut stream = frame(&[]);
        stream.extend(frame(&[7, 8]));
        let frames = collect(&stream).expect("zero-length frame is skipped");
        assert_eq!(frames, vec![vec![7, 8]]);
    }

    #[test]
    fn truncated_payload_errors() {
        let mut stream = 10u32.to_le_bytes().to_vec();
        stream.extend_from_slice(&[1, 2, 3]); // only 3 of 10 payload bytes
        let err = collect(&stream).expect_err("truncated payload must error");
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn truncated_header_errors() {
        let mut stream = frame(&[5, 6]);
        stream.extend_from_slice(&[0x01, 0x00]); // 2 of 4 header bytes
        let err = collect(&stream).expect_err("truncated header must error");
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn oversized_frame_rejected() {
        let stream = (MAX_FRAME_LEN + 1).to_le_bytes().to_vec();
        let err = collect(&stream).expect_err("oversized frame must error");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn length_prefix_is_little_endian() {
        // 0x0102 = 258-byte payload; LE header bytes [0x02, 0x01, 0x00, 0x00]
        let mut stream = vec![0x02, 0x01, 0x00, 0x00];
        stream.extend(std::iter::repeat_n(0x5A, 258));
        let frames = collect(&stream).expect("LE length parses");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), 258);
    }

    // --- unexpected-exit detection (silent-EOF fix) ---

    #[cfg(unix)]
    fn spawn_sleeper() -> Child {
        Command::new("sh")
            .arg("-c")
            .arg("sleep 30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleeper")
    }

    #[cfg(unix)]
    #[test]
    fn take_child_matching_generation_clears_slot() {
        let slot = Mutex::new(Some(SidecarState {
            generation: 5,
            child: spawn_sleeper(),
        }));
        let taken = take_child_if_current(&slot, 5);
        assert!(taken.is_some(), "matching generation must yield the child");
        assert!(
            slot.lock().unwrap().is_none(),
            "slot must be cleared so the next start_system_capture succeeds"
        );
        let mut child = taken.unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn take_child_stale_generation_leaves_slot_untouched() {
        let slot = Mutex::new(Some(SidecarState {
            generation: 6,
            child: spawn_sleeper(),
        }));
        assert!(
            take_child_if_current(&slot, 5).is_none(),
            "stale generation must not claim a newer child"
        );
        let state = slot.lock().unwrap().take();
        let mut state = state.expect("newer child must still be registered");
        assert_eq!(state.generation, 6);
        let _ = state.child.kill();
        let _ = state.child.wait();
    }

    #[test]
    fn take_child_empty_slot_is_none() {
        let slot: Mutex<Option<SidecarState>> = Mutex::new(None);
        assert!(
            take_child_if_current(&slot, 1).is_none(),
            "empty slot means a stop already claimed the child: stay silent"
        );
    }

    #[cfg(unix)]
    #[test]
    fn reap_child_collects_own_exit_status() {
        let child = Command::new("sh")
            .arg("-c")
            .arg("exit 7")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn exiting child");
        let status = reap_child(child).expect("child that exited by itself yields its status");
        assert_eq!(status.code(), Some(7));
    }

    #[cfg(unix)]
    #[test]
    fn reap_child_kills_lingering_child() {
        let child = spawn_sleeper();
        let pid = child.id();
        assert!(
            reap_child(child).is_none(),
            "a child that keeps running past the grace period is killed, not waited on"
        );
        // After reap_child the process must be gone (kill(pid, 0) fails).
        let alive = Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stderr(Stdio::null())
            .status()
            .expect("run kill -0")
            .success();
        assert!(!alive, "lingering sidecar must be dead after reap_child");
    }

    #[cfg(unix)]
    #[test]
    fn exit_message_is_distinguishable() {
        let status = Command::new("sh")
            .arg("-c")
            .arg("exit 3")
            .status()
            .expect("run sh");
        let with_status = sidecar_exit_message(Some(status));
        assert!(
            with_status.starts_with("sidecar exited"),
            "message must be distinguishable from stream errors: {with_status}"
        );
        assert!(
            with_status.contains('3'),
            "message carries the exit code: {with_status}"
        );

        let without_status = sidecar_exit_message(None);
        assert!(without_status.starts_with("sidecar exited"));
        assert_ne!(with_status, without_status);
    }
}
