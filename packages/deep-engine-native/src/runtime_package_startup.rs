use std::path::{Path, PathBuf};

use deep_engine_native::runtime_package::{
    LoadedRuntimePackage, RuntimePackageSummary, load_and_validate_runtime_package,
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

pub fn verify(
    path: &Path,
    verification: crate::publication_verification::Verification,
) -> Result<(), String> {
    // Exact candidate verification never recovers a different LKG package.
    let package = load(path)?;
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
