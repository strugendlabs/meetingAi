//! In-process Windows WASAPI capture. No helper executable or console window.
//! Process loopback excludes MeetingAI and its WebView2 child processes, so
//! translated speech cannot feed back into the transcript. Requires Windows 11.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

const FRAME_BYTES: usize = 8000; // 250 ms, PCM16 LE mono, 16 kHz.
struct CaptureState {
    stop: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}
static CAPTURE: Mutex<Option<CaptureState>> = Mutex::new(None);

#[derive(Clone, serde::Serialize)]
struct Chunk {
    data: String,
}
#[derive(Clone, serde::Serialize)]
struct CaptureError {
    message: String,
}

struct ComGuard;
impl ComGuard {
    fn new() -> Result<Self, String> {
        wasapi::initialize_mta()
            .ok()
            .map_err(|e| format!("Audio initialization failed: {e}"))?;
        Ok(Self)
    }
}
impl Drop for ComGuard {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}

fn initialize() -> Result<AudioClient, String> {
    let mut client = AudioClient::new_application_loopback_client(std::process::id(), false)
        .map_err(|e| format!("Call audio needs Windows 11 with an enabled output device. Process audio capture could not start: {e}"))?;
    let format = WaveFormat::new(16, 16, &SampleType::Int, 16000, 1, None);
    client
        .initialize_client(
            &format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: 0,
            },
        )
        .map_err(|e| format!("Could not initialize call audio: {e}"))?;
    Ok(client)
}

fn drain_frames(queue: &mut VecDeque<u8>, mut emit: impl FnMut(&[u8])) {
    while queue.len() >= FRAME_BYTES {
        let frame: Vec<u8> = queue.drain(..FRAME_BYTES).collect();
        emit(&frame);
    }
}

fn capture_loop(
    app: &AppHandle,
    stop: &AtomicBool,
    ready: &mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let _com = ComGuard::new()?;
    let client = initialize()?;
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client
        .start_stream()
        .map_err(|e| format!("Could not start call audio: {e}"))?;
    let _ = ready.try_send(Ok(()));
    let mut queue = VecDeque::with_capacity(FRAME_BYTES * 2);
    let result = (|| {
        while !stop.load(Ordering::Acquire) {
            // A silent output can legitimately produce no events. Poll packets
            // after this bounded wait, which also keeps Stop responsive.
            let _ = event.wait_for_event(100);
            while !stop.load(Ordering::Acquire)
                && capture
                    .get_next_packet_size()
                    .map_err(|e| e.to_string())?
                    .unwrap_or(0)
                    > 0
            {
                capture
                    .read_from_device_to_deque(&mut queue)
                    .map_err(|e| format!("Call audio disconnected: {e}"))?;
                drain_frames(&mut queue, |frame| {
                    if !stop.load(Ordering::Acquire) {
                        let _ = app.emit(
                            "system-audio-chunk",
                            Chunk {
                                data: B64.encode(frame),
                            },
                        );
                    }
                });
            }
        }
        Ok(())
    })();
    let _ = client.stop_stream();
    result
}

#[tauri::command]
pub async fn start_system_capture(app: AppHandle) -> Result<(), String> {
    let ready = {
        let mut slot = CAPTURE
            .lock()
            .map_err(|_| "Audio capture state unavailable")?;
        if slot
            .as_ref()
            .is_some_and(|state| !state.worker.is_finished())
        {
            return Err(
                "Call audio is already running or still stopping. Retry in a moment.".into(),
            );
        }
        if let Some(previous) = slot.take() {
            let _ = previous.worker.join();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let (started, ready) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("meetingai-wasapi".into())
            .spawn(move || {
                if let Err(message) = capture_loop(&app, &worker_stop, &started) {
                    let _ = started.try_send(Err(message.clone()));
                    if !worker_stop.load(Ordering::Acquire) {
                        let _ = app.emit("system-audio-error", CaptureError { message });
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        *slot = Some(CaptureState { stop, worker });
        ready
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        ready
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| {
                Err("Call audio did not start. Check your Windows output device and retry.".into())
            })
    })
    .await
    .map_err(|e| e.to_string())?;
    if result.is_err() {
        shutdown_capture();
    }
    result
}

pub fn shutdown_capture() {
    if let Ok(slot) = CAPTURE.lock() {
        if let Some(state) = slot.as_ref() {
            state.stop.store(true, Ordering::Release);
        }
    }
}

#[tauri::command]
pub async fn stop_system_capture() -> Result<(), String> {
    shutdown_capture();
    tauri::async_runtime::spawn_blocking(|| {
        for _ in 0..20 {
            {
                let mut slot = CAPTURE
                    .lock()
                    .map_err(|_| "Audio capture state unavailable")?;
                if slot.as_ref().is_none_or(|state| state.worker.is_finished()) {
                    if let Some(state) = slot.take() {
                        let _ = state.worker.join();
                    }
                    return Ok(());
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err("Call audio is still stopping. Retry in a moment.".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_system_audio_permission(_app: AppHandle) -> Result<bool, String> {
    // Windows has no screen-recording toggle for this API. Check on a dedicated
    // MTA thread; bound the UI wait even if the OS activation callback stalls.
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (|| {
            let _com = ComGuard::new()?;
            let _client = initialize()?;
            Ok(true)
        })();
        let _ = tx.send(result);
    });
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| {
                Err("Windows audio check timed out. Check your output device.".into())
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_audio_settings(source: String) -> Result<(), String> {
    let destination = match source.as_str() {
        "microphone" => "ms-settings:privacy-microphone",
        "system" | "input" => "ms-settings:sound",
        _ => return Err("Unknown audio settings page".into()),
    };
    std::process::Command::new("explorer.exe")
        .arg(destination)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_preserve_pcm_order_and_partial_tail() {
        let input: Vec<u8> = (0..(FRAME_BYTES * 2 + 126))
            .map(|i| (i % 251) as u8)
            .collect();
        let mut queue = VecDeque::from(input.clone());
        let mut frames = Vec::new();
        drain_frames(&mut queue, |frame| frames.push(frame.to_vec()));
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|f| f.len() == FRAME_BYTES));
        assert_eq!(
            [frames.concat(), queue.into_iter().collect()].concat(),
            input
        );
    }
    #[test]
    fn short_packets_accumulate_without_loss() {
        let mut queue = VecDeque::new();
        let mut lengths = Vec::new();
        for _ in 0..5 {
            queue.extend(vec![0; FRAME_BYTES / 5]);
            drain_frames(&mut queue, |frame| lengths.push(frame.len()));
        }
        assert_eq!(lengths, [FRAME_BYTES]);
        assert!(queue.is_empty());
    }
}
