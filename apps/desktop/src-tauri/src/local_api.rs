use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalApiConnection {
    base_url: String,
    access_token: String,
}

#[derive(Default)]
pub(crate) struct LocalApiManager {
    child: Mutex<Option<Child>>,
    connection: Mutex<Option<LocalApiConnection>>,
}

impl LocalApiManager {
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock()
            && let Some(mut process) = child.take()
        {
            let _ = process.kill();
            let _ = process.wait();
        }
        if let Ok(mut connection) = self.connection.lock() {
            *connection = None;
        }
    }
}

impl Drop for LocalApiManager {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut()
            && let Some(process) = child.as_mut()
        {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

#[tauri::command]
pub(crate) async fn start_local_api<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, LocalApiManager>,
) -> Result<LocalApiConnection, String> {
    if let Some(connection) = manager
        .connection
        .lock()
        .map_err(|_| "本地 API 状态锁损坏")?
        .clone()
    {
        let running = manager
            .child
            .lock()
            .map_err(|_| "本地 API 进程锁损坏")?
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none());
        if running && local_api_healthy(&connection.base_url) {
            return Ok(connection);
        }
        manager.stop();
    }

    let (runtime_dir, node, entry) = local_api_runtime(&app)?;
    let workspace = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位本地工作区：{error}"))?
        .join("workspace");
    let data_dir = workspace.join("data");
    let logs_dir = workspace.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|error| format!("创建本地工作区失败：{error}"))?;
    let publication_environment = prepare_publication_environment(&runtime_dir, &workspace)?;

    let port = reserve_loopback_port()?;
    let base_url = format!("http://127.0.0.1:{port}");
    let access_token = random_hex(32)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("local-api.log"))
        .map_err(|error| format!("创建本地 API 日志失败：{error}"))?;
    let error_log = log
        .try_clone()
        .map_err(|error| format!("打开本地 API 错误日志失败：{error}"))?;

    // Tauri's Windows resource directory may use the `\\?\` verbatim prefix.
    // Node treats a verbatim main-module path as a malformed drive-relative path
    // (`D:`) and exits with EISDIR, so only the child-process boundary is
    // converted back to the equivalent DOS/UNC spelling.
    let child_runtime_dir = child_process_path(&runtime_dir);
    let child_node = child_process_path(&node);
    let child_entry = child_process_path(&entry);
    let mut command = Command::new(child_node);
    command
        .arg(child_entry)
        .current_dir(child_runtime_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .env("NODE_ENV", "desktop-local")
        .env("BIM_STUDIO_DEPLOYMENT_MODE", "desktop-local")
        .env("BIM_STUDIO_DESKTOP_LOCAL_TOKEN", &access_token)
        .env("BIM_STUDIO_SESSION_SECRET", random_hex(32)?)
        .env("BIM_STUDIO_ADMIN_PASSWORD", random_hex(24)?)
        .env("API_HOST", "127.0.0.1")
        .env("API_PORT", port.to_string())
        .env("WEB_ORIGIN", desktop_web_origin())
        .env("METADATA_STORE", "sqlite")
        .env("SQLITE_DATABASE", workspace.join("metadata.sqlite"))
        .env("OBJECT_STORE", "local")
        .env("DATA_DIR", &data_dir);
    for (name, value) in publication_environment {
        command.env(name, child_process_path(&value));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动本地 API 失败：{error}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("读取本地 API 状态失败：{error}"))?
        {
            return Err(format!(
                "本地 API 提前退出：{status}；详情见本地工作区 logs/local-api.log"
            ));
        }
        if local_api_healthy(&base_url) {
            let connection = LocalApiConnection {
                base_url,
                access_token,
            };
            *manager.child.lock().map_err(|_| "本地 API 进程锁损坏")? = Some(child);
            *manager
                .connection
                .lock()
                .map_err(|_| "本地 API 状态锁损坏")? = Some(connection.clone());
            return Ok(connection);
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("本地 API 启动超时；详情见本地工作区 logs/local-api.log".to_owned())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicationRuntimeManifest {
    schema: String,
    schema_version: u8,
    resources: BTreeMap<String, PublicationResource>,
    environment: BTreeMap<String, String>,
    dashboard_deployment_template: Value,
}

#[derive(Debug, Deserialize)]
struct PublicationResource {
    path: String,
}

fn prepare_publication_environment(
    runtime_dir: &Path,
    workspace: &Path,
) -> Result<Vec<(String, PathBuf)>, String> {
    let manifest_path = runtime_dir.join("publication-runtime.json");
    if !manifest_path.is_file() {
        if cfg!(debug_assertions) {
            return Ok(Vec::new());
        }
        return Err("本地发布运行资源不完整，请重新安装客户端".to_owned());
    }
    let bytes =
        fs::read(&manifest_path).map_err(|error| format!("读取本地发布资源清单失败：{error}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err("本地发布资源清单超过 1 MiB".to_owned());
    }
    let manifest: PublicationRuntimeManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析本地发布资源清单失败：{error}"))?;
    if manifest.schema != "deep-monkey.local-publication-runtime" || manifest.schema_version != 1 {
        return Err("本地发布资源清单版本不受支持".to_owned());
    }
    let mut resource_paths = HashMap::new();
    for (name, resource) in manifest.resources {
        let resolved = resolve_runtime_path(runtime_dir, &resource.path)?;
        if !resolved.is_file() {
            return Err(format!("本地发布资源缺失：{}", resource.path));
        }
        resource_paths.insert(name, resolved);
    }

    let mut dashboard = manifest.dashboard_deployment_template;
    materialize_dashboard_value(&mut dashboard, runtime_dir, &resource_paths)?;
    let configuration_dir = workspace.join("config");
    fs::create_dir_all(&configuration_dir)
        .map_err(|error| format!("创建本地发布配置目录失败：{error}"))?;
    let dashboard_file = configuration_dir.join("dashboard-native.json");
    let dashboard_bytes = serde_json::to_vec_pretty(&dashboard)
        .map_err(|error| format!("生成 Dashboard 本地发布配置失败：{error}"))?;
    fs::write(&dashboard_file, dashboard_bytes)
        .map_err(|error| format!("写入 Dashboard 本地发布配置失败：{error}"))?;

    let allowed = [
        "NATIVE_SCENE_VERIFIER_EXECUTABLE",
        "JAVA_HOME",
        "DASHBOARD_NATIVE_DEPLOYMENT_FILE",
        "THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE",
    ];
    let mut environment = Vec::new();
    for name in allowed {
        let value = manifest
            .environment
            .get(name)
            .ok_or_else(|| format!("本地发布资源清单缺少环境映射：{name}"))?;
        let resolved = if value == "@generated:workspace/config/dashboard-native.json" {
            dashboard_file.clone()
        } else if value == "@runtime:current-executable" {
            std::env::current_exe().map_err(|error| format!("无法定位当前桌面启动器：{error}"))?
        } else {
            let path = resolve_runtime_path(runtime_dir, value)?;
            if !path.exists() {
                return Err(format!("本地发布环境资源缺失：{value}"));
            }
            path
        };
        environment.push((name.to_owned(), resolved));
    }
    Ok(environment)
}

fn materialize_dashboard_value(
    value: &mut Value,
    runtime_dir: &Path,
    resources: &HashMap<String, PathBuf>,
) -> Result<(), String> {
    match value {
        Value::Array(values) => {
            for value in values {
                materialize_dashboard_value(value, runtime_dir, resources)?;
            }
        }
        Value::Object(object) => {
            if object.len() == 1 {
                if let Some(Value::String(resource)) = object.get("resource") {
                    let resolved = resources
                        .get(resource)
                        .ok_or_else(|| format!("Dashboard 配置引用未知资源：{resource}"))?;
                    *value = Value::String(resolved.to_string_lossy().into_owned());
                    return Ok(());
                }
                if let Some(Value::String(relative)) = object.get("relativePath") {
                    let resolved = resolve_runtime_path(runtime_dir, relative)?;
                    if !resolved.exists() {
                        return Err(format!("Dashboard 配置目录缺失：{relative}"));
                    }
                    *value = Value::String(resolved.to_string_lossy().into_owned());
                    return Ok(());
                }
            }
            for value in object.values_mut() {
                materialize_dashboard_value(value, runtime_dir, resources)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn resolve_runtime_path(runtime_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(relative);
    if candidate.as_os_str().is_empty()
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("本地发布资源路径必须是安全相对路径：{relative}"));
    }
    Ok(runtime_dir.join(candidate))
}

fn local_api_runtime<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位客户端资源目录：{error}"))?
        .join("local-api");
    let bundled_node = bundled.join(if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    });
    let bundled_entry = bundled.join("dist").join("index.js");
    if bundled_node.is_file() && bundled_entry.is_file() {
        return Ok((bundled, bundled_node, bundled_entry));
    }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../api");
        let entry = development.join("dist").join("index.js");
        if entry.is_file() {
            return Ok((development, PathBuf::from("node"), entry));
        }
    }
    Err("本地 API 运行资源不完整，请重新安装客户端".to_owned())
}

#[cfg(target_os = "windows")]
fn child_process_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

#[cfg(not(target_os = "windows"))]
fn child_process_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("无法分配本地 API 端口：{error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("无法读取本地 API 端口：{error}"))
}

fn local_api_healthy(base_url: &str) -> bool {
    let Ok(address) = base_url
        .strip_prefix("http://")
        .and_then(|value| value.parse::<SocketAddr>().ok())
        .ok_or(())
    else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"status\":\"ok\"")
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value).map_err(|error| format!("生成本地 API 凭据失败：{error}"))?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn desktop_web_origin() -> &'static str {
    if cfg!(debug_assertions) {
        "http://localhost:5173"
    } else {
        "http://tauri.localhost"
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_parent_runtime_paths() {
        let root = Path::new("runtime");
        assert!(resolve_runtime_path(root, "publication/native.exe").is_ok());
        assert!(resolve_runtime_path(root, "../native.exe").is_err());
        assert!(resolve_runtime_path(root, "C:/native.exe").is_err());
        assert!(resolve_runtime_path(root, "").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn converts_verbatim_paths_for_node_child_processes() {
        assert_eq!(
            child_process_path(Path::new(r"\\?\D:\Deep Monkey\local-api\dist\index.js")),
            PathBuf::from(r"D:\Deep Monkey\local-api\dist\index.js")
        );
        assert_eq!(
            child_process_path(Path::new(r"\\?\UNC\server\share\node.exe")),
            PathBuf::from(r"\\server\share\node.exe")
        );
        assert_eq!(
            child_process_path(Path::new(r"D:\Deep Monkey\node.exe")),
            PathBuf::from(r"D:\Deep Monkey\node.exe")
        );
    }

    #[test]
    fn materializes_publication_environment_and_dashboard_paths() {
        let root =
            std::env::temp_dir().join(format!("bim-local-publication-{}", random_hex(8).unwrap()));
        let runtime = root.join("runtime");
        let workspace = root.join("workspace");
        for relative in [
            "publication/native/player.exe",
            "publication/native/probe.json",
            "publication/android/template.apk",
            "publication/android/jre/bin/java.exe",
        ] {
            let file = runtime.join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"test").unwrap();
        }
        fs::create_dir_all(runtime.join("publication/android/build-tools")).unwrap();
        let manifest = serde_json::json!({
            "schema": "deep-monkey.local-publication-runtime", "schemaVersion": 1,
            "resources": {
                "nativeExecutable": { "path": "publication/native/player.exe" },
                "nativeProbePackage": { "path": "publication/native/probe.json" },
                "androidTemplate": { "path": "publication/android/template.apk" },
                "javaExecutable": { "path": "publication/android/jre/bin/java.exe" }
            },
            "environment": {
                "NATIVE_SCENE_VERIFIER_EXECUTABLE": "publication/native/player.exe",
                "JAVA_HOME": "publication/android/jre",
                "DASHBOARD_NATIVE_DEPLOYMENT_FILE": "@generated:workspace/config/dashboard-native.json",
                "THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE": "@runtime:current-executable"
            },
            "dashboardDeploymentTemplate": {
                "nativeExecutable": { "resource": "nativeExecutable" },
                "deviceFingerprint": { "mode": "runtime-local", "probePackagePath": { "resource": "nativeProbePackage" } },
                "androidApk": { "templateApkPath": { "resource": "androidTemplate" },
                    "buildToolsPath": { "relativePath": "publication/android/build-tools" } }
            }
        });
        fs::write(
            runtime.join("publication-runtime.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let environment = prepare_publication_environment(&runtime, &workspace).unwrap();
        assert_eq!(environment.len(), 4);
        assert_eq!(
            environment
                .iter()
                .find(|(name, _)| name == "THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE")
                .map(|(_, path)| path),
            Some(&std::env::current_exe().unwrap())
        );
        let dashboard: Value = serde_json::from_slice(
            &fs::read(workspace.join("config/dashboard-native.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            dashboard["nativeExecutable"],
            runtime
                .join("publication/native/player.exe")
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(
            dashboard["androidApk"]["buildToolsPath"],
            runtime
                .join("publication/android/build-tools")
                .to_string_lossy()
                .as_ref()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
