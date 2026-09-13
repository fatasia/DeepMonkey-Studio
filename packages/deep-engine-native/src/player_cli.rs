use std::{env, fs, path::PathBuf};

use deep_engine_native::{
    bloom::BloomSettings,
    contract::load_and_validate,
    deep2d::{Deep2dRuntimeContent, decode_runtime_content},
    runtime_package::load_and_validate_runtime_package,
};

use crate::{app, player_content::PlayerContent};

pub enum PackageMode {
    Viewer,
    Smoke,
    Headless,
}

pub fn run_package(path: PathBuf, mode: PackageMode) -> Result<(), String> {
    let package = load_and_validate_runtime_package(&path).map_err(|error| error.to_string())?;
    let summary = package.summary();
    let id = package.package_id.clone();
    let version = package.package_version.clone();
    let hash = package.package_hash.clone();
    let content = PlayerContent::from_package(package)?;
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
        BloomSettings::default(),
    )
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
        "Deep Engine Native Player\n\n  deep-engine-native --package <runtime-package.json>\n  deep-engine-native --headless-package <runtime-package.json>\n  deep-engine-native --smoke-package <runtime-package.json>\n  deep-engine-native\n  deep-engine-native --packet <render-packet.json>\n  deep-engine-native --no-bloom [render-packet.json]\n  deep-engine-native --headless-contract [render-packet.json]\n  deep-engine-native --headless-pbr [render-packet.json]\n  deep-engine-native --headless-alpha [render-packet.json]\n  deep-engine-native --headless-ibl\n  deep-engine-native --headless-deep2d [deep2d.json]\n  deep-engine-native --smoke-frame [render-packet.json]\n  deep-engine-native --smoke-no-bloom [render-packet.json]\n  deep-engine-native --smoke-textured\n  deep-engine-native --smoke-textured-deep2d\n  deep-engine-native --smoke-alpha\n  deep-engine-native --smoke-alpha-deep2d\n  deep-engine-native --smoke-shadow [render-packet.json]\n  deep-engine-native --smoke-shadow-update [render-packet.json]\n  deep-engine-native --smoke-ibl [render-packet.json]\n  deep-engine-native --smoke-shader-package\n  deep-engine-native --smoke-deep2d-interleaved\n  deep-engine-native --smoke-deep2d [deep2d.json]\n  deep-engine-native --packet-with-deep2d <render-packet.json> <deep2d.json>\n\nArrow keys rotate the mesh, R rebuilds the GPU state, Esc exits."
    );
}
