//! Local inference bridge. No redirects, proxies, DNS or cloud fallback.
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{multipart, Client};
use serde_json::Value;
use std::time::Duration;
use url::{Host, Url};

fn endpoint(base: &str, route: &str) -> Result<Url, String> {
    let mut url = Url::parse(base.trim()).map_err(|_| "Enter a valid local server URL")?;
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "" | "/") {
        return Err("Use an http:// loopback server URL without credentials or a path".into());
    }
    match url.host() {
        Some(Host::Ipv4(ip)) if ip.is_loopback() => {},
        Some(Host::Ipv6(ip)) if ip.is_loopback() => {},
        Some(Host::Domain("localhost")) => { url.set_host(Some("127.0.0.1")).map_err(|_| "Invalid host")?; },
        _ => return Err("Local mode accepts only localhost or a loopback IP address".into()),
    }
    url.set_path(route);
    Ok(url)
}

fn client() -> Result<Client, String> {
    Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(120))
        .build().map_err(|_| "Could not create local inference client".into())
}

async fn read_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() { return Err(format!("Local server returned HTTP {}. Check the server and selected model.", status.as_u16())); }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Local server response was interrupted")? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 { return Err("Local response is too large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Local server did not return valid JSON".into())
}

fn connection_error(_: reqwest::Error) -> String {
    "Could not reach the local server, or inference timed out. Start it and test the connection in Settings.".into()
}

#[tauri::command]
pub async fn local_ai_request(base_url: String, route: String, body: Option<Value>) -> Result<Value, String> {
    if !matches!(route.as_str(), "/api/tags" | "/api/show" | "/api/chat") {
        return Err("Unsupported local AI route".into());
    }
    let url = endpoint(&base_url, &route)?;
    let client = client()?;
    let request = if route == "/api/tags" { client.get(url) }
        else { client.post(url).json(&body.unwrap_or(Value::Null)) };
    read_response(request.send().await.map_err(connection_error)?).await
}

#[tauri::command]
pub async fn local_speech_transcribe(base_url: String, wav_base64: String, language: Option<String>) -> Result<Value, String> {
    let url = endpoint(&base_url, "/inference")?;
    if wav_base64.len() > 2_000_000 { return Err("Audio chunk exceeds the local recognition limit".into()); }
    let audio = STANDARD.decode(wav_base64).map_err(|_| "Invalid WAV audio")?;
    if audio.len() < 44 || &audio[..4] != b"RIFF" || &audio[8..12] != b"WAVE" { return Err("Expected WAV audio".into()); }
    let language = language.unwrap_or_else(|| "auto".into());
    if language != "auto" && (!(2..=3).contains(&language.len()) || !language.bytes().all(|b| b.is_ascii_lowercase())) {
        return Err("Choose a valid spoken-language code or auto detection".into());
    }
    let file = multipart::Part::bytes(audio).file_name("speech.wav").mime_str("audio/wav").map_err(|_| "Invalid audio type")?;
    let mut form = multipart::Form::new().part("file", file).text("response_format", "json")
        .text("language", language.clone()).text("translate", "false").text("temperature", "0");
    // A script hint helps Hindi output stay in Devanagari rather than Urdu.
    // It contains no invented meeting facts, vocabulary, or participant names.
    if language == "hi" { form = form.text("prompt", "यह हिंदी में बातचीत है।"); }
    read_response(client()?.post(url).multipart(form).send().await.map_err(connection_error)?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_loopback_without_credentials_or_redirects() {
        assert_eq!(endpoint("http://localhost:11434", "/api/chat").unwrap().as_str(), "http://127.0.0.1:11434/api/chat");
        assert!(endpoint("http://[::1]:11434/", "/api/tags").is_ok());
        for bad in ["https://ollama.com", "http://192.168.1.2", "http://localhost.evil.test", "http://user:pass@127.0.0.1", "http://127.0.0.1/api", "http://127.0.0.1?proxy=x", "file:///tmp/server"] {
            assert!(endpoint(bad, "/api/chat").is_err(), "accepted {bad}");
        }
    }

    /// Opt-in integration test; sends only the caller's synthetic WAV and test prompts.
    #[test]
    #[ignore = "requires local Ollama, whisper.cpp and MEETINGAI_TEST_WAV"]
    fn local_services_round_trip() {
        tauri::async_runtime::block_on(async {
            let ollama = std::env::var("MEETINGAI_TEST_OLLAMA_URL").unwrap_or("http://127.0.0.1:11434".into());
            let whisper = std::env::var("MEETINGAI_TEST_WHISPER_URL").unwrap_or("http://127.0.0.1:8080".into());
            let model = std::env::var("MEETINGAI_TEST_MODEL").expect("set MEETINGAI_TEST_MODEL");
            let tags = local_ai_request(ollama.clone(), "/api/tags".into(), None).await.unwrap();
            assert!(tags["models"].as_array().unwrap().iter().any(|m| m["name"] == model));
            let show = local_ai_request(ollama.clone(), "/api/show".into(), Some(serde_json::json!({"model":model}))).await.unwrap();
            assert!(!show["model_info"].as_object().unwrap().is_empty());
            let chat = local_ai_request(ollama, "/api/chat".into(), Some(serde_json::json!({
                "model":model, "stream":false, "think":false,
                "messages":[{"role":"user","content":"Reply with exactly: LOCAL_OK"}],
                "options":{"temperature":0,"num_predict":2048}
            }))).await.unwrap();
            assert!(chat["message"]["content"].as_str().unwrap().contains("LOCAL_OK"));
            let audio = std::fs::read(std::env::var("MEETINGAI_TEST_WAV").expect("set MEETINGAI_TEST_WAV")).unwrap();
            let text = local_speech_transcribe(whisper, STANDARD.encode(audio), std::env::var("MEETINGAI_TEST_LANGUAGE").ok()).await.unwrap();
            let recognized = text["text"].as_str().unwrap().to_lowercase();
            let expected = std::env::var("MEETINGAI_TEST_WORDS").unwrap_or("friday,draft".into());
            for word in expected.split(',').map(str::trim).filter(|word| !word.is_empty()) {
                assert!(recognized.contains(&word.to_lowercase()), "synthetic fixture should contain {word}: {recognized}");
            }
        });
    }
}
