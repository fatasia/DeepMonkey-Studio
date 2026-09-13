use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{
    AppHandle, Manager, Runtime,
    utils::config::WebviewUrl,
    webview::{NewWindowResponse, WebviewWindowBuilder},
};
use url::Url;

const PROFILE_FILE: &str = "server-profile.json";
const AUTH_TOKEN_FILE: &str = "auth-token.bin";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    id: String,
    name: String,
    base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_server_instance_id: Option<String>,
}

impl ServerProfile {
    fn validated(mut self) -> Result<Self, String> {
        self.id = self.id.trim().to_owned();
        self.name = self.name.trim().to_owned();
        if self.id.is_empty()
            || self.id.len() > 64
            || !self.id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            })
        {
            return Err("服务器配置 ID 不合法".to_owned());
        }
        if self.name.is_empty() || self.name.chars().count() > 80 {
            return Err("服务器名称不能为空且不能超过 80 个字符".to_owned());
        }
        let parsed =
            Url::parse(self.base_url.trim()).map_err(|_| "服务器地址必须是完整的 HTTP(S) URL")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.host_str().is_none()
        {
            return Err("服务器地址只允许 HTTP(S) 协议，且不能包含账号、查询参数或片段".to_owned());
        }
        self.base_url = parsed.origin().ascii_serialization();
        self.expected_server_instance_id = self
            .expected_server_instance_id
            .take()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        Ok(self)
    }
}

fn profile_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(PROFILE_FILE))
        .map_err(|error| format!("无法定位客户端配置目录：{error}"))
}

fn auth_token_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(AUTH_TOKEN_FILE))
        .map_err(|error| format!("无法定位客户端登录凭据目录：{error}"))
}

#[cfg(target_os = "windows")]
fn protect_auth_token(token: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: token.len() as u32,
        pbData: token.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let result = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 {
        return Err(format!(
            "加密登录凭据失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let encrypted =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(encrypted)
}

#[cfg(target_os = "windows")]
fn unprotect_auth_token(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let result = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 {
        return Err(format!(
            "解密登录凭据失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let token = unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(token)
}

#[cfg(not(target_os = "windows"))]
fn protect_auth_token(_token: &[u8]) -> Result<Vec<u8>, String> {
    Err("当前平台不支持系统凭据加密".to_owned())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_auth_token(_encrypted: &[u8]) -> Result<Vec<u8>, String> {
    Err("当前平台不支持系统凭据解密".to_owned())
}

fn load_auth_token(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let encrypted = fs::read(path).map_err(|error| format!("读取登录凭据失败：{error}"))?;
    let token = unprotect_auth_token(&encrypted)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|_| "登录凭据编码损坏".to_owned()))?;
    Ok((!token.is_empty()).then_some(token))
}

fn save_auth_token(path: &Path, token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 16 * 1024 {
        return Err("登录凭据为空或长度异常".to_owned());
    }
    let directory = path
        .parent()
        .ok_or_else(|| "登录凭据路径无父目录".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建客户端凭据目录失败：{error}"))?;
    let encrypted = protect_auth_token(token.as_bytes())?;
    let temporary = path.with_extension("bin.tmp");
    let mut file =
        fs::File::create(&temporary).map_err(|error| format!("创建临时凭据失败：{error}"))?;
    file.write_all(&encrypted)
        .map_err(|error| format!("写入临时凭据失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步临时凭据失败：{error}"))?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("替换登录凭据失败：{error}"))?;
    }
    fs::rename(temporary, path).map_err(|error| format!("激活登录凭据失败：{error}"))
}

fn clear_auth_token_files(path: &Path) -> Result<(), String> {
    for candidate in [path.to_path_buf(), path.with_extension("bin.tmp")] {
        if candidate.exists() {
            fs::remove_file(candidate).map_err(|error| format!("删除登录凭据失败：{error}"))?;
        }
    }
    Ok(())
}

fn load_profile(path: &Path) -> Result<Option<ServerProfile>, String> {
    if path.exists() {
        return read_profile_file(path).map(Some);
    }
    // 进程若在旧配置备份后异常退出，启动时仍可恢复最近一次有效配置。
    let backup = path.with_extension("json.bak");
    if backup.exists() {
        return read_profile_file(&backup).map(Some);
    }
    Ok(None)
}

fn read_profile_file(path: &Path) -> Result<ServerProfile, String> {
    let bytes = fs::read(path).map_err(|error| format!("读取服务器配置失败：{error}"))?;
    serde_json::from_slice::<ServerProfile>(&bytes)
        .map_err(|error| format!("服务器配置损坏：{error}"))?
        .validated()
}

fn save_profile(path: &Path, profile: &ServerProfile) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "服务器配置路径无父目录".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建客户端配置目录失败：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(profile)
        .map_err(|error| format!("序列化服务器配置失败：{error}"))?;
    let mut file =
        fs::File::create(&temporary).map_err(|error| format!("创建临时配置失败：{error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("写入临时配置失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步临时配置失败：{error}"))?;
    let backup = path.with_extension("json.bak");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| format!("清理旧配置备份失败：{error}"))?;
    }
    if path.exists() {
        fs::rename(path, &backup).map_err(|error| format!("备份当前服务器配置失败：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() && !path.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!("激活服务器配置失败：{error}"));
    }
    if backup.exists() {
        fs::remove_file(backup).map_err(|error| format!("清理服务器配置备份失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_server_profile<R: Runtime>(app: AppHandle<R>) -> Result<Option<ServerProfile>, String> {
    load_profile(&profile_path(&app)?)
}

#[tauri::command]
fn set_server_profile<R: Runtime>(
    app: AppHandle<R>,
    profile: ServerProfile,
) -> Result<ServerProfile, String> {
    let profile = profile.validated()?;
    save_profile(&profile_path(&app)?, &profile)?;
    Ok(profile)
}

#[tauri::command]
fn clear_server_profile<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = profile_path(&app)?;
    for candidate in [
        path.clone(),
        path.with_extension("json.tmp"),
        path.with_extension("json.bak"),
    ] {
        if candidate.exists() {
            fs::remove_file(candidate).map_err(|error| format!("删除服务器配置失败：{error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn get_auth_token<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let path = auth_token_path(&app)?;
    match load_auth_token(&path) {
        Ok(token) => Ok(token),
        Err(_) => {
            let _ = clear_auth_token_files(&path);
            Ok(None)
        }
    }
}

#[tauri::command]
fn set_auth_token<R: Runtime>(app: AppHandle<R>, token: String) -> Result<(), String> {
    save_auth_token(&auth_token_path(&app)?, &token)
}

#[tauri::command]
fn clear_auth_token<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    clear_auth_token_files(&auth_token_path(&app)?)
}

#[derive(Debug, PartialEq, Eq)]
enum NewWindowPolicy {
    ScriptEditor,
    Default,
}

fn classify_new_window_request(url: &Url) -> NewWindowPolicy {
    if url.scheme() == "about"
        && url.path() == "blank"
        && url.query().is_none()
        && url.fragment().is_none()
    {
        NewWindowPolicy::ScriptEditor
    } else {
        NewWindowPolicy::Default
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let main_config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("missing main window configuration")?;
            let app_handle = app.handle().clone();
            WebviewWindowBuilder::from_config(app, main_config)?
                .on_document_title_changed(|window, title| {
                    // 运行时品牌可由服务器配置，主窗口始终跟随页面标题。
                    let _ = window.set_title(&title);
                })
                .on_new_window(move |url, features| {
                    if classify_new_window_request(&url) == NewWindowPolicy::Default {
                        // 普通预览、场景跳转和外部链接继续使用 WebView 默认新窗口行为；
                        // 只有 about:blank 才由桌面宿主接管为低权限脚本编辑器。
                        return NewWindowResponse::Allow;
                    }
                    let builder = WebviewWindowBuilder::new(
                        &app_handle,
                        "script-editor",
                        WebviewUrl::External("about:blank".parse().expect("valid about:blank URL")),
                    )
                    .window_features(features)
                    .title("脚本编辑器 · Deep Monkey Studio")
                    // 脚本窗口使用独立系统窗口，不设 owner/parent；保留任务栏及系统窗口按钮。
                    .always_on_top(false)
                    .decorations(true)
                    .resizable(true)
                    .minimizable(true)
                    .maximizable(true)
                    .skip_taskbar(false)
                    .on_document_title_changed(|window, title| {
                        let _ = window.set_title(&title);
                    });
                    match builder.build() {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(_) => NewWindowResponse::Deny,
                    }
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_profile,
            set_server_profile,
            clear_server_profile,
            get_auth_token,
            set_auth_token,
            clear_auth_token
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Deep Monkey Studio desktop host");
}

#[cfg(test)]
mod tests {
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
}
