use std::path::{Path, PathBuf};

use deep_engine_native::runtime_package::{
    LoadedRuntimePackage, RuntimePackageSummary, load_and_validate_runtime_package,
};
use serde::Serialize;

use crate::{app, player_cli::PackageMode, player_content::PlayerContent};

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
            let bytes = store
                .map_err(|reason| format!("primary rejected: {error}; {reason}"))?
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
            Ok(package)
        }
    }
}

pub fn presented(content: &mut PlayerContent) -> Option<String> {
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
    app::run_verification(package.content, verification.bind_hash(package.hash))
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
    app::run(
        content,
        matches!(mode, PackageMode::Smoke),
        false,
        false,
        deep_engine_native::bloom::BloomSettings::default(),
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
