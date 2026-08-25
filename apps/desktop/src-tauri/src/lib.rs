use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

const PROFILE_FILE: &str = "server-profile.json";

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
            || !self
                .id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
        {
            return Err("服务器配置 ID 不合法".to_owned());
        }
        if self.name.is_empty() || self.name.chars().count() > 80 {
            return Err("服务器名称不能为空且不能超过 80 个字符".to_owned());
        }
        let parsed = Url::parse(self.base_url.trim()).map_err(|_| "服务器地址必须是完整的 HTTP(S) URL")?;
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

fn load_profile(path: &Path) -> Result<Option<ServerProfile>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| format!("读取服务器配置失败：{error}"))?;
    let profile = serde_json::from_slice::<ServerProfile>(&bytes)
        .map_err(|error| format!("服务器配置损坏：{error}"))?
        .validated()?;
    Ok(Some(profile))
}

fn save_profile(path: &Path, profile: &ServerProfile) -> Result<(), String> {
    let directory = path.parent().ok_or_else(|| "服务器配置路径无父目录".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建客户端配置目录失败：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(profile).map_err(|error| format!("序列化服务器配置失败：{error}"))?;
    let mut file = fs::File::create(&temporary).map_err(|error| format!("创建临时配置失败：{error}"))?;
    file.write_all(&bytes).map_err(|error| format!("写入临时配置失败：{error}"))?;
    file.sync_all().map_err(|error| format!("同步临时配置失败：{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("激活服务器配置失败：{error}"))
}

#[tauri::command]
fn get_server_profile<R: Runtime>(app: AppHandle<R>) -> Result<Option<ServerProfile>, String> {
    load_profile(&profile_path(&app)?)
}

#[tauri::command]
fn set_server_profile<R: Runtime>(app: AppHandle<R>, profile: ServerProfile) -> Result<ServerProfile, String> {
    let profile = profile.validated()?;
    save_profile(&profile_path(&app)?, &profile)?;
    Ok(profile)
}

#[tauri::command]
fn clear_server_profile<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = profile_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("删除服务器配置失败：{error}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_server_profile,
            set_server_profile,
            clear_server_profile
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Dev Studio desktop host");
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
        assert!(profile("https://user:secret@studio.example.test").validated().is_err());
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
        assert_eq!(load_profile(&path).expect("profile should load"), Some(expected));

        fs::remove_dir_all(directory).expect("test directory should be removable");
    }
}
