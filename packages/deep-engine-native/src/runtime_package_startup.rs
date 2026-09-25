use std::fs;
use std::path::{Path, PathBuf};

use deep_engine_native::runtime_package::{
    LoadedRuntimePackage, RuntimePackageSummary, load_and_validate_runtime_package,
    parse_and_validate_r3_state_ops,
};
use serde::Serialize;

use crate::{app, player_cli::PackageMode, player_content::PlayerContent, renderer};

pub struct PreparedRuntimePackage {
    content: PlayerContent,
    summary: RuntimePackageSummary,
    id: String,
    version: String,
    hash: String,
}

impl PreparedRuntimePackage {
    pub(crate) fn summary(&self) -> &RuntimePackageSummary {
        &self.summary
    }

    pub(crate) fn into_content(self) -> PlayerContent {
        self.content
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryDiagnostic<'a> {
    code: &'a str,
    active: &'a str,
    package_id: &'a str,
    package_version: &'a str,
    package_hash: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    primary_rejection: Option<&'a str>,
}

pub fn load(path: &Path) -> Result<PreparedRuntimePackage, String> {
    let package = load_and_validate_runtime_package(path).map_err(|error| error.to_string())?;
    let mut prepared = prepare(package)?;
    prepared
        .content
        .bind_resource_source(path, "runtime-file")?;
    Ok(prepared)
}

#[cfg(target_arch = "wasm32")]
pub fn load_bytes(bytes: &[u8]) -> Result<PreparedRuntimePackage, String> {
    let package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(bytes)
        .map_err(|error| error.to_string())?;
    prepare(package)
}

pub fn load_embedded(path: &Path) -> Result<Option<PreparedRuntimePackage>, String> {
    let mut executable =
        std::fs::File::open(path).map_err(|error| format!("overlay/open: {error}"))?;
    let Some(bytes) = deep_engine_native::executable_overlay::read(&mut executable)? else {
        return Ok(None);
    };
    let loaded = deep_engine_native::runtime_package::parse_and_validate_runtime_package(&bytes)
        .map_err(|error| format!("overlay/runtime-package: {error}"))?;
    let mut package = prepare(loaded)?;
    package
        .content
        .bind_resource_source(path, "embedded-runtime")?;
    match crate::runtime_lkg::Store::local(path) {
        Ok(store) => {
            package.content.pending_lkg = Some(crate::runtime_lkg::Pending {
                store,
                bytes,
                hash: package.hash.clone(),
            })
        }
        Err(error) => {
            package.content.startup_notice = Some(format!("recovery cache unavailable: {error}"))
        }
    }
    Ok(Some(package))
}

pub fn load_auto(path: &Path) -> Result<PreparedRuntimePackage, String> {
    use deep_engine_native::runtime_package::{
        parse_and_validate_runtime_package, read_runtime_package_bytes,
    };
    let store = crate::runtime_lkg::Store::local(path);
    let primary = read_runtime_package_bytes(path)
        .map_err(|e| e.to_string())
        .and_then(|bytes| {
            let loaded = parse_and_validate_runtime_package(&bytes).map_err(|e| e.to_string())?;
            Ok((prepare(loaded)?, bytes))
        });
    match primary {
        Ok((mut package, bytes)) => {
            package.content.bind_resource_source(path, "runtime-file")?;
            match store {
                Ok(store) => {
                    package.content.pending_lkg = Some(crate::runtime_lkg::Pending {
                        store,
                        bytes,
                        hash: package.hash.clone(),
                    })
                }
                Err(error) => {
                    package.content.startup_notice =
                        Some(format!("recovery cache unavailable: {error}"))
                }
            }
            Ok(package)
        }
        Err(error) => {
            let store = store.map_err(|reason| format!("primary rejected: {error}; {reason}"))?;
            let bytes = store
                .restore()
                .map_err(|reason| format!("primary rejected: {error}; {reason}"))?;
            let mut package =
                prepare(parse_and_validate_runtime_package(&bytes).map_err(|e| e.to_string())?)?;
            package.content.bind_resource_source(path, "runtime-file")?;
            report(
                "primary-rejected",
                "last-known-good",
                &package,
                Some(&error),
            )?;
            package.content.startup_notice =
                Some("recovered last-known-good: source package rejected".into());
            // 恢复内容与主包/嵌入式载荷同受呈现合同约束:成功呈现后才提交检查点
            // (runtime_lkg 的唯一提交门槛),重提交同时把恢复状态巩固为活动检查点。
            package.content.pending_lkg = Some(crate::runtime_lkg::Pending {
                store,
                bytes,
                hash: package.hash.clone(),
            });
            Ok(package)
        }
    }
}

pub fn presented(content: &mut PlayerContent) -> Option<String> {
    if let Some(pending) = content.pending_x_lkg.take() {
        match pending.store.commit_x(&pending.bytes, &pending.hash) {
            Ok(()) => println!("native X package recovery checkpoint committed after present"),
            Err(error) => {
                eprintln!(
                    "native X package recovery checkpoint failed; current scene retained: {error}"
                );
                content.startup_notice = Some(format!("scene ready; X recovery failed: {error}"));
            }
        }
    }
    if let Some(pending) = content.pending_asset_lkg.take() {
        match pending.commit() {
            Ok(()) => println!("native asset recovery checkpoint committed after present"),
            Err(error) => {
                eprintln!(
                    "native asset recovery checkpoint failed; current scene retained: {error}"
                );
                content.startup_notice =
                    Some(format!("scene ready; asset recovery failed: {error}"));
            }
        }
    }
    if let Some(pending) = content.pending_lkg.take() {
        match pending.store.commit(&pending.bytes, &pending.hash) {
            Ok(()) => println!("native package recovery checkpoint committed after present"),
            Err(error) => {
                eprintln!(
                    "native package recovery checkpoint failed; current scene retained: {error}"
                );
                content.startup_notice =
                    Some(format!("scene ready; recovery cache failed: {error}"));
            }
        }
    }
    content.startup_notice.take()
}

pub fn recover(
    primary: PathBuf,
    last_known_good: PathBuf,
    mode: PackageMode,
) -> Result<(), String> {
    match load(&primary) {
        Ok(package) => {
            report("primary-accepted", "primary", &package, None)?;
            run(package, mode)
        }
        Err(primary_error) => match load(&last_known_good) {
            Ok(package) => {
                report(
                    "primary-rejected",
                    "last-known-good",
                    &package,
                    Some(&primary_error),
                )?;
                run(package, mode)
            }
            Err(fallback_error) => {
                let failure = serde_json::json!({
                    "code": "no-valid-runtime-package",
                    "active": "none",
                    "primaryRejection": primary_error,
                    "lastKnownGoodRejection": fallback_error,
                });
                Err(format!("runtime package startup recovery: {failure}"))
            }
        },
    }
}

/// `--verify-package` 只验证 scene 发布候选。dashboard 内容包的正式链是
/// `.dmda` 归档 + `run-dashboard-client-native`(`--package` 播放)与
/// `--verify-dashboard-package`(同域验证);误入 scene 验证器的 dashboard 包
/// 在此快速 fail-closed 拒绝——空 3D 场景的 dashboard 包不该被 scene 渲染链
/// 消费,更不该在初始化失败后挂到超时。
fn reject_non_scene_content(content: &PlayerContent) -> Result<(), String> {
    if content.dashboard.is_some() {
        return Err(
            "runtime package verification requires a scene package; dashboard packages verify through the .dmda archive chain (run-dashboard-client-native, --verify-dashboard-package)".into(),
        );
    }
    Ok(())
}

/// `--verify-dashboard-package` 的对称方向:只接受 dashboard 内容包。
/// scene 发布候选的验证入口仍是 `--verify-package`,两者不得互相串链。
fn reject_non_dashboard_content(content: &PlayerContent) -> Result<(), String> {
    if content.dashboard.is_none() {
        return Err(
            "dashboard package verification requires a dashboard package; scene candidates verify through --verify-package".into(),
        );
    }
    Ok(())
}

pub fn verify(
    path: &Path,
    verification: crate::publication_verification::Verification,
) -> Result<(), String> {
    // Exact candidate verification never recovers a different LKG package.
    let package = load(path)?;
    reject_non_scene_content(&package.content)?;
    let bloom = renderer::entry_bloom(&package.content);
    app::run_verification(package.content, verification.bind_hash(package.hash), bloom)
}

/// Dashboard 正式链的窗口验证:与 scene `verify` 共用同一套
/// `publication_verification` 报告机制(nonce、呈现帧、GPU 干净、设备指纹、
/// draw layers),只差内容方向——验证前先拒绝非 dashboard 包,防止 scene
/// 候选误入 dashboard 验证命令。
pub fn verify_dashboard(
    path: &Path,
    verification: crate::publication_verification::Verification,
) -> Result<(), String> {
    // Exact candidate verification never recovers a different LKG package.
    let package = load(path)?;
    reject_non_dashboard_content(&package.content)?;
    let bloom = renderer::entry_bloom(&package.content);
    app::run_verification(package.content, verification.bind_hash(package.hash), bloom)
}

pub fn run(package: PreparedRuntimePackage, mode: PackageMode) -> Result<(), String> {
    let PreparedRuntimePackage {
        content,
        summary,
        id,
        version,
        hash,
    } = package;
    println!(
        "Deep Runtime Package Player preflight OK: id={id} version={version} hash={hash} resources={} geometries={} materials={} instances={} textures={} triangles={} deep2d={} shader_packages={} environment={} environment_revision={}",
        summary.resources,
        summary.geometries,
        summary.materials,
        summary.instances,
        summary.textures,
        summary.triangles,
        summary.has_deep2d,
        summary.shader_packages,
        content.environment.id,
        content.environment.revision
    );
    if matches!(mode, PackageMode::Headless) {
        return Ok(());
    }
    let bloom = renderer::entry_bloom(&content);
    app::run(
        content,
        matches!(mode, PackageMode::Smoke),
        false,
        false,
        bloom,
    )
}

/// `--smoke-dynamic-package`: real-window playback of the dynamic runtime
/// channel. Requires the channel to exist — a static package must fail the
/// dynamic gate instead of pretending to play.
pub fn run_dynamic_playback(package: PreparedRuntimePackage) -> Result<(), String> {
    let PreparedRuntimePackage {
        content,
        summary,
        id,
        version,
        hash,
    } = package;
    println!(
        "Deep Runtime Package Dynamic Player preflight OK: id={id} version={version} hash={hash} resources={} geometries={} instances={} triangles={} deep2d={}",
        summary.resources,
        summary.geometries,
        summary.instances,
        summary.triangles,
        summary.has_deep2d,
    );
    let duration_ms = content.dynamic_runtime_duration_ms().ok_or(
        "runtime package has no dynamic runtime channel; real-window playback requires one",
    )?;
    if duration_ms == 0 {
        return Err(
            "dynamic runtime has no animation clock; real-window playback requires durationMs > 0"
                .into(),
        );
    }
    let snapshot = content.runtime_package().cloned();
    let (package_id, package_version, package_hash) = snapshot
        .map(|snapshot| {
            (
                snapshot.package_id,
                snapshot.package_version,
                snapshot.package_hash,
            )
        })
        .unwrap_or((id, version, hash));
    let spec = app::DynamicPlaybackSpec {
        step_ms: app::DYNAMIC_PLAYBACK_STEP_MS,
        duration_ms,
        package_id,
        package_version,
        package_hash,
    };
    app::run_dynamic_playback(content, spec)
}

/// `--smoke-state-ops <ops.json> <runtime-package.json>`: real-window playback
/// of the frozen R3 state-op sequence. Requires the ops to be frozen against
/// exactly this package hash — a mismatched pair fails instead of replaying.
pub fn run_state_ops(ops_path: &Path, package: PreparedRuntimePackage) -> Result<(), String> {
    let PreparedRuntimePackage {
        content,
        summary,
        id,
        version,
        hash,
    } = package;
    let raw = fs::read_to_string(ops_path)
        .map_err(|error| format!("state ops file cannot be read: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("state ops JSON is invalid: {error}"))?;
    let ops = parse_and_validate_r3_state_ops(value)?;
    if ops.package_hash != hash {
        return Err(format!(
            "state ops were frozen against package hash {} but the loaded package is {hash}",
            ops.package_hash
        ));
    }
    println!(
        "Deep Runtime Package State Ops Player preflight OK: id={id} version={version} hash={hash} resources={} geometries={} instances={} triangles={} deep2d={} steps={}",
        summary.resources,
        summary.geometries,
        summary.instances,
        summary.triangles,
        summary.has_deep2d,
        ops.steps.len(),
    );
    app::run_state_ops_playback(
        content,
        app::StateOpsSpec {
            ops,
            package_hash: hash,
        },
    )
}

fn prepare(package: LoadedRuntimePackage) -> Result<PreparedRuntimePackage, String> {
    let summary = package.summary();
    let id = package.package_id.clone();
    let version = package.package_version.clone();
    let hash = package.package_hash.clone();
    let content = PlayerContent::from_package(package)?;
    Ok(PreparedRuntimePackage {
        content,
        summary,
        id,
        version,
        hash,
    })
}

fn report(
    code: &str,
    active: &str,
    package: &PreparedRuntimePackage,
    primary_rejection: Option<&str>,
) -> Result<(), String> {
    let diagnostic = RecoveryDiagnostic {
        code,
        active,
        package_id: &package.id,
        package_version: &package.version,
        package_hash: &package.hash,
        primary_rejection,
    };
    let encoded = serde_json::to_string(&diagnostic)
        .map_err(|error| format!("cannot encode startup recovery diagnostic: {error}"))?;
    println!("Deep Runtime Package startup recovery: {encoded}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dashboard 内容包误入 `--verify-package` 必须在进入渲染前被明确拒绝
    /// (指向 `.dmda` + run-dashboard-client-native 正式链),而不是让空 3D
    /// 场景走进 scene 渲染链后在初始化阶段报错甚至挂到验证器超时。
    #[test]
    fn verification_rejects_dashboard_content_before_any_rendering() {
        let golden = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
            include_bytes!("../../deep-engine/fixtures/dashboard-composition-v1.json").as_slice(),
        )
        .unwrap();
        let content = PlayerContent::from_package(golden).unwrap();
        assert!(content.dashboard.is_some(), "golden is a dashboard package");
        let error = reject_non_scene_content(&content).unwrap_err();
        assert!(error.contains("scene package"), "{error}");
        assert!(error.contains("run-dashboard-client-native"), "{error}");
        // 对称方向:同一 dashboard 包必须被 dashboard 验证入口接受。
        assert!(reject_non_dashboard_content(&content).is_ok());
    }

    /// Dashboard 验证入口必须拒绝 scene 内容——两个验证命令互不串链,
    /// 任何方向的内容错配都在渲染前 fail-closed。
    #[test]
    fn dashboard_verification_rejects_scene_content_before_any_rendering() {
        let fixture = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
            std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/runtime-package-v1.json"),
            )
            .unwrap()
            .as_slice(),
        )
        .unwrap();
        let content = PlayerContent::from_package(fixture).unwrap();
        assert!(content.dashboard.is_none(), "fixture is a scene package");
        let error = reject_non_dashboard_content(&content).unwrap_err();
        assert!(error.contains("dashboard package"), "{error}");
        assert!(error.contains("--verify-package"), "{error}");
        assert!(reject_non_scene_content(&content).is_ok());
    }

    fn fixture() -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/runtime-package-v1.json"),
        )
        .unwrap()
    }

    #[test]
    fn rejected_primary_restores_last_known_good_with_pending_checkpoint() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let source = std::env::temp_dir().join(format!("deep-lkg-recovery-{nonce}.runtime.json"));
        let bytes = fixture();
        // 建立检查点:源文件尚合法时提交,随后把源文件破坏以强制走恢复分支。
        std::fs::write(&source, &bytes).unwrap();
        let store = crate::runtime_lkg::Store::local(&source).unwrap();
        let hash = deep_engine_native::runtime_package::parse_and_validate_runtime_package(&bytes)
            .unwrap()
            .package_hash;
        store.commit(&bytes, &hash).unwrap();
        std::fs::write(&source, b"broken").unwrap();
        let package = load_auto(&source).unwrap();
        assert!(
            package
                .content
                .startup_notice
                .as_deref()
                .unwrap()
                .contains("last-known-good")
        );
        // 恢复启动必须挂起检查点:成功呈现后重提交以巩固恢复状态,
        // 同时驱动呈现合同信号(submission check + checkpoint committed)。
        let pending = package
            .content
            .pending_lkg
            .expect("recovery startup keeps a pending checkpoint");
        assert_eq!(pending.hash, hash);
        assert_eq!(pending.bytes, bytes);
        pending.store.commit(&pending.bytes, &pending.hash).unwrap();
        assert_eq!(
            crate::runtime_lkg::Store::local(&source)
                .unwrap()
                .restore()
                .unwrap(),
            bytes
        );
        let _ = std::fs::remove_file(&source);
        let key = deep_engine_native::runtime_package::runtime_content_sha256(&serde_json::json!(
            source.to_string_lossy().to_lowercase()
        ));
        if let Some(root) = std::env::var_os("LOCALAPPDATA") {
            let _ = std::fs::remove_dir_all(
                std::path::PathBuf::from(root)
                    .join("DeepEngineNative/package-recovery")
                    .join(key),
            );
        }
    }
}
