mod audio_bridge;
mod db;
mod ducking;
mod keychain;
mod local_ai;
mod oauth;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            ducking::duck_system_volume,
            ducking::restore_system_volume,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            local_ai::local_ai_request,
            local_ai::local_speech_transcribe,
            oauth::google_oauth_start,
            oauth::google_oauth_refresh,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
