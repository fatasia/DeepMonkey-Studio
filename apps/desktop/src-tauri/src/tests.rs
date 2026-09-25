use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn profile(base_url: &str) -> ServerProfile {
    ServerProfile {
        id: "primary".to_owned(),
        name: "主服务器".to_owned(),
        base_url: base_url.to_owned(),
        expected_server_instance_id: Some("server-1".to_owned()),
    }
}

#[test]
fn validates_and_normalizes_server_profile() {
    let normalized = profile(" https://studio.example.test:8443/path ")
        .validated()
        .expect("profile should validate");
    assert_eq!(normalized.base_url, "https://studio.example.test:8443");
}

#[test]
fn rejects_credentials_and_non_http_protocols() {
    assert!(profile("ftp://studio.example.test").validated().is_err());
    assert!(
        profile("https://user:secret@studio.example.test")
            .validated()
            .is_err()
    );
}

#[test]
fn only_routes_the_empty_popup_to_the_script_editor() {
    assert_eq!(
        classify_new_window_request(&Url::parse("about:blank").unwrap()),
        NewWindowPolicy::ScriptEditor
    );
    for candidate in [
        "https://example.test",
        "data:text/html,test",
        "tauri://localhost",
        "about:blank#external",
    ] {
        assert_eq!(
            classify_new_window_request(&Url::parse(candidate).unwrap()),
            NewWindowPolicy::Default
        );
    }
}

#[test]
fn persists_and_loads_profile_without_broad_filesystem_access() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be available")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!("bim-studio-desktop-test-{unique}"));
    let path = directory.join(PROFILE_FILE);
    let expected = profile("http://127.0.0.1:4100")
        .validated()
        .expect("profile should validate");

    save_profile(&path, &expected).expect("profile should save");
    assert_eq!(
        load_profile(&path).expect("profile should load"),
        Some(expected)
    );

    let updated = ServerProfile {
        name: "备用服务器".to_owned(),
        base_url: "https://backup.example.test".to_owned(),
        ..profile("http://127.0.0.1:4100")
    }
    .validated()
    .expect("updated profile should validate");
    save_profile(&path, &updated).expect("existing profile should update on Windows");
    assert_eq!(
        load_profile(&path).expect("updated profile should load"),
        Some(updated.clone())
    );

    let backup = path.with_extension("json.bak");
    fs::rename(&path, &backup).expect("interrupted replacement should leave a backup");
    assert_eq!(
        load_profile(&path).expect("backup profile should recover"),
        Some(updated)
    );

    fs::remove_dir_all(directory).expect("test directory should be removable");
}

#[test]
#[cfg(target_os = "windows")]
fn persists_auth_tokens_with_windows_user_encryption() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be available")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!("bim-studio-auth-test-{unique}"));
    let path = directory.join(AUTH_TOKEN_FILE);
    let token = "remember.sensitive-session-token";

    save_auth_token(&path, token).expect("token should save");
    let encrypted = fs::read(&path).expect("encrypted token should exist");
    assert!(!String::from_utf8_lossy(&encrypted).contains(token));
    assert_eq!(
        load_auth_token(&path)
            .expect("token should load")
            .as_deref(),
        Some(token)
    );
    clear_auth_token_files(&path).expect("token should clear");
    assert!(!path.exists());
    let _ = fs::remove_dir_all(directory);
}
