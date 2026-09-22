#[cfg(not(windows))]
mod audio_bridge;
#[cfg(windows)]
#[path = "windows_audio.rs"]
mod audio_bridge;
mod db;
mod ducking;
mod keychain;
mod local_ai;
mod oauth;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:meetingai.db", db::migrations())
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            audio_bridge::start_system_capture,
            audio_bridge::stop_system_capture,
            audio_bridge::check_system_audio_permission,
            audio_bridge::open_audio_settings,
            ducking::duck_system_volume,
            ducking::restore_system_volume,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_unlock,
            keychain::keychain_delete,
            local_ai::local_ai_request,
            local_ai::local_speech_transcribe,
            oauth::google_oauth_start,
            oauth::google_oauth_refresh,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                audio_bridge::shutdown_capture();
            }
        });
}
