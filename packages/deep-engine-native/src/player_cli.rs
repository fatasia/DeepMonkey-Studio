use std::{env, fs, path::PathBuf};

use deep_engine_native::{
    bloom::BloomSettings,
    contract::load_and_validate,
    deep2d::{Deep2dRuntimeContent, decode_runtime_content},
    runtime_package::{runtime_content_sha256, runtime_package_sha256},
};

use crate::{app, player_content::PlayerContent, runtime_package_startup};

pub enum PackageMode {
    Viewer,
    Smoke,
    Headless,
}

pub fn run_package(path: PathBuf, mode: PackageMode) -> Result<(), String> {
    let package = runtime_package_startup::load_auto(&path)?;
    runtime_package_startup::run(package, mode)
}

/// `--smoke-dynamic-package`: real-window playback with an exit receipt.
pub fn run_dynamic_playback_package(path: PathBuf) -> Result<(), String> {
    let package = runtime_package_startup::load_auto(&path)?;
    runtime_package_startup::run_dynamic_playback(package)
}

/// `--smoke-state-ops <ops.json> <runtime-package.json>`: real-window playback
/// of a frozen clipping/selection op sequence with an exit receipt.
pub fn run_state_ops_package(ops_path: PathBuf, package_path: PathBuf) -> Result<(), String> {
    let package = runtime_package_startup::load_auto(&package_path)?;
    runtime_package_startup::run_state_ops(&ops_path, package)
}

pub fn required_path(
    args: &mut impl Iterator<Item = std::ffi::OsString>,
    option: &str,
) -> Result<PathBuf, String> {
    let path = args
        .next()
        .ok_or_else(|| format!("{option} requires a runtime package JSON path"))?;
    if path.is_empty() || path.to_string_lossy().starts_with('-') {
        return Err(format!(
            "{option} requires a runtime package JSON path; other command modes cannot be combined"
        ));
    }
    Ok(path.into())
}

pub fn run_viewer(
    path: PathBuf,
    display_list: Option<Deep2dRuntimeContent>,
    smoke_frame: bool,
) -> Result<(), String> {
    run_viewer_mode(path, display_list, smoke_frame, false, false)
}

pub fn run_viewer_without_bloom(path: PathBuf, smoke_frame: bool) -> Result<(), String> {
    run_viewer_configured(
        path,
        None,
        smoke_frame,
        false,
        false,
        BloomSettings::DISABLED,
    )
}

pub fn run_shadow_update_probe(path: PathBuf) -> Result<(), String> {
    let (initial, _) = load_and_validate(&path)?;
    let (mut rejected, _) = load_and_validate(&path)?;
    let vertex = rejected
        .geometries
        .first_mut()
        .and_then(|geometry| geometry.vertices.first_mut())
        .ok_or("shadow update probe requires indexed geometry")?;
    *vertex += 0.125;
    let (mut replacement, _) = load_and_validate(&path)?;
    let caster = replacement
        .instances
        .get_mut(1)
        .ok_or("shadow update probe requires receiver and caster instances")?;
    caster.transform[12] = -0.45;
    caster.transform[13] = 0.55;
    caster.transform[14] = 1.05;
    let (mut out_of_range, _) = load_and_validate(&path)?;
    out_of_range
        .instances
        .first_mut()
        .ok_or("shadow update probe requires a receiver instance")?
        .transform[12] = 2_000_000.0;
    app::run_shadow_update_probe(
        PlayerContent::from_packet(initial, None),
        PlayerContent::from_packet(rejected, None),
        PlayerContent::from_packet(out_of_range, None),
        PlayerContent::from_packet(replacement, None),
    )
}

pub fn run_viewer_mode(
    path: PathBuf,
    display_list: Option<Deep2dRuntimeContent>,
    smoke_frame: bool,
    shadow_probe: bool,
    ibl_probe: bool,
) -> Result<(), String> {
    run_viewer_configured(
        path,
        display_list,
        smoke_frame,
        shadow_probe,
        ibl_probe,
        BloomSettings::default(),
    )
}

fn run_viewer_configured(
    path: PathBuf,
    display_list: Option<Deep2dRuntimeContent>,
    smoke_frame: bool,
    shadow_probe: bool,
    ibl_probe: bool,
    bloom: BloomSettings,
) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run(
        PlayerContent::from_packet(packet, display_list),
        smoke_frame,
        shadow_probe,
        ibl_probe,
        bloom,
    )
}

/// `--packet-live`: interactive viewer whose packet file is watched for updates.
/// `--smoke-packet-live` variant watches a temp copy and self-rewrites it.
pub fn run_packet_live(path: PathBuf, smoke: bool) -> Result<(), String> {
    let (watch_path, smoke_rewrite) = if smoke {
        let source = fs::read(&path).map_err(|error| format!("cannot read {path:?}: {error}"))?;
        let watch_path = std::env::temp_dir().join(format!(
            "deep-engine-native-packet-live-smoke-{}.json",
            std::process::id()
        ));
        fs::write(&watch_path, &source)
            .map_err(|error| format!("cannot stage smoke watch file: {error}"))?;
        (watch_path, Some(moved_packet_bytes(&source)?))
    } else {
        (path.clone(), None)
    };
    let (packet, summary) = load_and_validate(&watch_path)?;
    println!(
        "packet live contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_packet_live(
        PlayerContent::from_packet(packet, None),
        app::PacketLiveSpec {
            watch_path,
            smoke_rewrite,
        },
    )
}

pub fn run_package_live(path: PathBuf, smoke: bool) -> Result<(), String> {
    let (watch_path, smoke_rewrite, smoke_rejected_rewrite) = if smoke {
        let source = fs::read(&path).map_err(|error| format!("cannot read {path:?}: {error}"))?;
        let watch_path = std::env::temp_dir().join(format!(
            "deep-engine-native-package-live-smoke-{}.json",
            std::process::id()
        ));
        fs::write(&watch_path, &source)
            .map_err(|error| format!("cannot stage package smoke watch file: {error}"))?;
        (
            watch_path,
            Some(moved_package_bytes(&source)?),
            Some(b"{".to_vec()),
        )
    } else {
        (path.clone(), None, None)
    };
    let package = crate::runtime_package_startup::load_auto(&watch_path)
        .map_err(|error| format!("runtime package live preflight failed: {error}"))?;
    let summary = package.summary();
    println!(
        "runtime package live preflight OK: resources={} geometries={} instances={} deep2d={} shader_packages={}",
        summary.resources,
        summary.geometries,
        summary.instances,
        summary.has_deep2d,
        summary.shader_packages
    );
    app::run_package_live(
        package.into_content(),
        app::PackageLiveSpec {
            watch_path,
            smoke_rewrite,
            smoke_rejected_rewrite,
        },
    )
}

fn moved_packet_bytes(source: &[u8]) -> Result<Vec<u8>, String> {
    let mut value: serde_json::Value =
        serde_json::from_slice(source).map_err(|error| format!("invalid smoke packet: {error}"))?;
    value["instances"][0]["transform"][12] = serde_json::json!(-0.75);
    serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("smoke packet encode failed: {error}"))
}

fn moved_package_bytes(source: &[u8]) -> Result<Vec<u8>, String> {
    let mut value: serde_json::Value = serde_json::from_slice(source)
        .map_err(|error| format!("invalid smoke runtime package: {error}"))?;
    let id = value["entrypoints"]["renderPacket"]
        .as_str()
        .ok_or("smoke runtime package has no renderPacket entry")?
        .to_owned();
    value["payloads"][&id]["instances"][0]["transform"][12] = serde_json::json!(-0.75);
    let hash = runtime_content_sha256(&value["payloads"][&id]);
    let resource = value["resources"]
        .as_array_mut()
        .and_then(|resources| resources.iter_mut().find(|resource| resource["id"] == id))
        .ok_or("smoke runtime package render resource is missing")?;
    resource["revision"] = serde_json::json!(resource["revision"].as_u64().unwrap_or(0) + 1);
    resource["contentHash"]["value"] = serde_json::json!(hash);
    value["packageHash"]["value"] =
        serde_json::json!(runtime_package_sha256(&value).map_err(|error| error.to_string())?);
    serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("smoke runtime package encode failed: {error}"))
}

/// `--smoke-occlusion`: R4 遮挡链真实窗口冒烟(见 runner::run_occlusion_smoke)。
pub fn run_occlusion_smoke(path: PathBuf) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "occlusion smoke contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_occlusion_smoke(PlayerContent::from_packet(packet, None))
}

/// `--smoke-telemetry`: smoke frame with segmented telemetry report at exit.
pub fn run_telemetry_smoke(path: PathBuf) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "telemetry smoke contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_telemetry_smoke(PlayerContent::from_packet(packet, None))
}

/// `--smoke-telemetry-prepare`:telemetry smoke + 采样窗内每帧一次真实
/// packet 更新(R6-2 准备细分采样)。
pub fn run_telemetry_smoke_prepare(path: PathBuf) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "telemetry prepare smoke contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_telemetry_smoke_prepare(PlayerContent::from_packet(packet, None))
}

/// `--smoke-telemetry-prepare-material`:telemetry prepare smoke 的材质摄动
/// 变体(首材质 metallic 数值翻转),采集 uniform-only 材质更新的准备样本。
pub fn run_telemetry_smoke_prepare_material(path: PathBuf) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "telemetry prepare(material) smoke contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_telemetry_smoke_prepare_material(PlayerContent::from_packet(packet, None))
}

/// C3 切片三:receive/cast/LOD/Structural 摄动的 telemetry prepare 采样入口。
pub fn run_telemetry_smoke_prepare_shadow(path: PathBuf) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "telemetry prepare(shadow) smoke contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_telemetry_smoke_prepare_shadow(PlayerContent::from_packet(packet, None))
}

pub fn run_telemetry_smoke_prepare_cast(path: PathBuf) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "telemetry prepare(cast) smoke contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_telemetry_smoke_prepare_cast(PlayerContent::from_packet(packet, None))
}

pub fn run_telemetry_smoke_prepare_lod(path: PathBuf) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "telemetry prepare(lod) smoke contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_telemetry_smoke_prepare_lod(PlayerContent::from_packet(packet, None))
}

pub fn run_telemetry_smoke_prepare_structural(path: PathBuf) -> Result<(), String> {
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "telemetry prepare(structural) smoke contract v1 loaded: {} geometries, {} instances, {} triangles",
        summary.geometries, summary.instances, summary.triangles
    );
    app::run_telemetry_smoke_prepare_structural(PlayerContent::from_packet(packet, None))
}

pub fn default_shadow_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/render_packet_shadow_v1.json")
}

pub fn load_deep2d(path: &std::path::Path) -> Result<Deep2dRuntimeContent, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    decode_runtime_content(&bytes)
}

pub fn reject_extra(mut args: impl Iterator<Item = std::ffi::OsString>) -> Result<(), String> {
    if let Some(argument) = args.next() {
        return Err(format!(
            "unexpected argument {:?}",
            argument.to_string_lossy()
        ));
    }
    Ok(())
}

pub fn print_help() {
    println!(
        "Experimental X viewer:\n  deep-engine-native --x-package <runtime-package-v6.json>\n  deep-engine-native --x-package-live <runtime-package-v6.json>\n  deep-engine-native --smoke-x-package <runtime-package-v6.json>"
    );
    println!(
        "Frozen-font CPU compilation: --rasterize-text <request.json> --output <new-result.json>\n  Glyph-run measurement (P1-18): --measure-glyph-run <request.json> --output <new-result.json>"
    );
    println!(
        "Deep Asset directory profile: --asset-package <manifest.json>; --headless-asset-package validates all chunks; --smoke-asset-package presents the entry scene."
    );
    println!(
        "C sections; X/Y/Z select axis, PageUp/PageDown move, [ ] rotate, Backspace resets.\nA adds an annotation; Enter confirms text, Esc cancels. F5 saves, F9 restores, Tab jumps, Delete removes.\n  deep-engine-native --smoke-section [render-packet.json]"
    );
    println!(
        "Click a triangle to select and focus its object; blank space clears selection. M toggles two-point measurement in scene units. Home resets the view.\n  deep-engine-native --smoke-selection [render-packet.json]\n  deep-engine-native --smoke-package-selection <runtime-package.json>"
    );
    println!(
        "Deep Engine Native Player\n\n  deep-engine-native --package <runtime-package.json>\n  deep-engine-native --headless-package <runtime-package.json>\n  deep-engine-native --headless-x-package <runtime-package-v6.json>\n  deep-engine-native --headless-x-package-ticks <runtime-package-v6.json> <count>\n  deep-engine-native --smoke-package <runtime-package.json>\n  deep-engine-native --smoke-dynamic-package <runtime-package.json>\n  deep-engine-native --smoke-state-ops <ops.json> <runtime-package.json>\n  deep-engine-native --package-recover <primary.json> <last-known-good.json>\n  deep-engine-native --headless-package-recover <primary.json> <last-known-good.json>\n  deep-engine-native --package-live <runtime-package.json>\n  deep-engine-native --smoke-package-live <runtime-package.json>\n  deep-engine-native\n  deep-engine-native --packet <render-packet.json>\n  deep-engine-native --packet-live <render-packet.json>\n  deep-engine-native --fog <density> <r> <g> <b> [render-packet.json]\n  deep-engine-native --smoke-fog <density> <r> <g> <b> [render-packet.json]\n  deep-engine-native --headless-fog <density> <r> <g> <b> [render-packet.json]\n  deep-engine-native --no-bloom [render-packet.json]\n  deep-engine-native --headless-contract [render-packet.json]\n  deep-engine-native --headless-pbr [render-packet.json]\n  deep-engine-native --headless-alpha [render-packet.json]\n  deep-engine-native --headless-ibl\n  deep-engine-native --chart <chart-ir.json>\n  deep-engine-native --smoke-chart <chart-ir.json>\n  deep-engine-native --headless-chart <chart-ir.json>\n  deep-engine-native --headless-deep2d [deep2d.json]\n  deep-engine-native --smoke-frame [render-packet.json]\n  deep-engine-native --smoke-no-bloom [render-packet.json]\n  deep-engine-native --smoke-textured\n  deep-engine-native --smoke-textured-deep2d\n  deep-engine-native --smoke-alpha\n  deep-engine-native --smoke-alpha-deep2d\n  deep-engine-native --smoke-shadow [render-packet.json]\n  deep-engine-native --smoke-shadow-update [render-packet.json]\n  deep-engine-native --smoke-packet-live\n  deep-engine-native --smoke-ibl [render-packet.json]\n  deep-engine-native --smoke-shader-package\n  deep-engine-native --smoke-deep2d-interleaved\n  deep-engine-native --smoke-deep2d [deep2d.json]\n  deep-engine-native --smoke-telemetry [render-packet.json]\n  deep-engine-native --packet-with-deep2d <render-packet.json> <deep2d.json>\n\nArrow keys rotate the mesh, R rebuilds the GPU state, Esc exits."
    );
}
