use std::{env, path::PathBuf};

use deep_engine_native::{
    contract::{
        default_alpha_fixture_path, default_fixture_path, default_textured_fixture_path,
        load_and_validate,
    },
    deep2d::{default_display_list_fixture_path, default_smoke_display_list_fixture_path},
    ibl::builtin_default_environment,
};

use crate::player_cli::{
    PackageMode, default_shadow_fixture_path, load_deep2d, print_help, reject_extra, required_path,
    run_package, run_package_live, run_packet_live, run_shadow_update_probe, run_telemetry_smoke,
    run_viewer, run_viewer_mode, run_viewer_without_bloom,
};
use crate::runtime_package_startup;
use crate::{deep2d_interleave_probe, fog_cli, shader_package_probe};

pub fn execute() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let first = args.next();
    let command = first
        .as_deref()
        .map(|value| {
            value
                .to_str()
                .ok_or("command must be valid Unicode; use --help")
        })
        .transpose()?;
    if let Some(result) = crate::cli_viewer_tools::execute(command, &mut args) {
        return result;
    }
    match command {
        Some("--help" | "-h") => {
            reject_extra(args)?;
            print_help();
            Ok(())
        }
        Some("--headless-contract") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_fixture_path().to_owned());
            reject_extra(args)?;
            let (_, summary) = load_and_validate(&path)?;
            println!(
                "RenderPacket contract OK: schema=deep-engine.render-packet version=1 geometries={} materials={} instances={} textures={} triangles={}",
                summary.geometries,
                summary.materials,
                summary.instances,
                summary.textures,
                summary.triangles
            );
            Ok(())
        }
        Some("--headless-pbr") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_textured_fixture_path().to_owned());
            reject_extra(args)?;
            let (packet, summary) = load_and_validate(&path)?;
            let pbr = deep_engine_native::pbr_texture::prepare_pbr_resources(&packet)?.summary();
            println!(
                "Native PBR contract OK: textures={} mip_levels={} srgb={} linear={} material_bindings={} triangles={}",
                pbr.textures,
                pbr.mip_levels,
                pbr.srgb_textures,
                pbr.linear_textures,
                pbr.material_bindings,
                summary.triangles
            );
            Ok(())
        }
        Some("--headless-alpha") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_alpha_fixture_path().to_owned());
            reject_extra(args)?;
            let (packet, summary) = load_and_validate(&path)?;
            let prepared = deep_engine_native::scene::prepare_scene(&packet)?;
            let alpha = deep_engine_native::scene::alpha_summary(&prepared.batches);
            let order = deep_engine_native::scene::transparent_batch_order(&prepared.batches, 0.0);
            println!(
                "Native alpha contract OK: opaque_batches={} mask_batches={} blend_batches={} double_sided_batches={} blend_order={order:?} instances={} triangles={}",
                alpha.opaque_batches,
                alpha.mask_batches,
                alpha.blend_batches,
                alpha.double_sided_batches,
                summary.instances,
                summary.triangles
            );
            Ok(())
        }
        Some("--headless-ibl") => {
            reject_extra(args)?;
            let environment = builtin_default_environment();
            let summary = environment.summary();
            println!(
                "Native IBL contract OK: id={} revision={} specular_mips={} specular_texels={} diffuse_texels={} brdf_texels={}",
                environment.id,
                environment.revision,
                summary.specular_mips,
                summary.specular_texels,
                summary.diffuse_texels,
                summary.brdf_texels
            );
            Ok(())
        }
        Some("--verify-package") => crate::publication_verification::execute(args),
        Some(option @ ("--package" | "--smoke-package" | "--headless-package")) => {
            let path = required_path(&mut args, option)?;
            reject_extra(args)?;
            let mode = match option {
                "--smoke-package" => PackageMode::Smoke,
                "--headless-package" => PackageMode::Headless,
                _ => PackageMode::Viewer,
            };
            run_package(path, mode)
        }
        Some(option @ ("--package-recover" | "--headless-package-recover")) => {
            let primary = required_path(&mut args, option)?;
            let last_known_good = required_path(&mut args, option)?;
            reject_extra(args)?;
            let mode = if option == "--headless-package-recover" {
                PackageMode::Headless
            } else {
                PackageMode::Viewer
            };
            runtime_package_startup::recover(primary, last_known_good, mode)
        }
        Some(option @ ("--package-live" | "--smoke-package-live")) => {
            let path = required_path(&mut args, option)?;
            reject_extra(args)?;
            run_package_live(path, option == "--smoke-package-live")
        }
        Some("--packet") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .ok_or("--packet requires a JSON path")?;
            reject_extra(args)?;
            run_viewer(path, None, false)
        }
        Some("--no-bloom") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_fixture_path().to_owned());
            reject_extra(args)?;
            run_viewer_without_bloom(path, false)
        }
        Some("--smoke-no-bloom") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_fixture_path().to_owned());
            reject_extra(args)?;
            run_viewer_without_bloom(path, true)
        }
        Some("--smoke-frame") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_fixture_path().to_owned());
            reject_extra(args)?;
            run_viewer(path, None, true)
        }
        Some("--smoke-textured") => {
            reject_extra(args)?;
            run_viewer(default_textured_fixture_path().to_owned(), None, true)
        }
        Some("--smoke-textured-deep2d") => {
            reject_extra(args)?;
            run_viewer(
                default_textured_fixture_path().to_owned(),
                Some(load_deep2d(default_smoke_display_list_fixture_path())?),
                true,
            )
        }
        Some("--smoke-alpha") => {
            reject_extra(args)?;
            run_viewer(default_alpha_fixture_path().to_owned(), None, true)
        }
        Some("--smoke-shadow") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(default_shadow_fixture_path);
            reject_extra(args)?;
            run_viewer_mode(path, None, true, true, false)
        }
        Some("--packet-live") => {
            let path = required_path(&mut args, "--packet-live")?;
            reject_extra(args)?;
            run_packet_live(path, false)
        }
        Some("--smoke-telemetry") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_fixture_path().to_owned());
            reject_extra(args)?;
            run_telemetry_smoke(path)
        }
        Some("--smoke-packet-live") => {
            reject_extra(args)?;
            run_packet_live(default_fixture_path().to_owned(), true)
        }
        Some("--smoke-shadow-update") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(default_shadow_fixture_path);
            reject_extra(args)?;
            run_shadow_update_probe(path)
        }
        Some("--smoke-ibl") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_textured_fixture_path().to_owned());
            reject_extra(args)?;
            run_viewer_mode(path, None, true, false, true)
        }
        Some(option @ ("--fog" | "--smoke-fog" | "--headless-fog")) => {
            fog_cli::run(args, option == "--smoke-fog", option == "--headless-fog")
        }
        Some("--smoke-shader-package") => {
            reject_extra(args)?;
            shader_package_probe::run()
        }
        Some("--smoke-deep2d-interleaved") => {
            reject_extra(args)?;
            deep2d_interleave_probe::run()
        }
        Some("--smoke-alpha-deep2d") => {
            reject_extra(args)?;
            run_viewer(
                default_alpha_fixture_path().to_owned(),
                Some(load_deep2d(default_smoke_display_list_fixture_path())?),
                true,
            )
        }
        Some("--headless-deep2d") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_display_list_fixture_path().to_owned());
            reject_extra(args)?;
            let display_list = load_deep2d(&path)?;
            let prepared = deep_engine_native::deep2d::prepare_runtime_content(&display_list)?;
            println!(
                "Deep2d contract/painter OK: commands={} path_segments={} fill_triangles={} stroke_triangles={} vertices={} atlases={} atlas_bytes={} glyph_quads={} image_quads={} batches={} chunks={}",
                prepared.summary.path.commands,
                prepared.summary.path.path_segments,
                prepared.summary.path.fill_triangles,
                prepared.summary.path.stroke_triangles,
                prepared.summary.path.vertices,
                prepared.summary.atlases,
                prepared.summary.atlas_bytes,
                prepared.summary.glyph_quads,
                prepared.summary.image_quads,
                prepared.summary.atlas_batches,
                prepared.summary.render_chunks
            );
            Ok(())
        }
        Some("--smoke-deep2d") => {
            let path = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(|| default_smoke_display_list_fixture_path().to_owned());
            reject_extra(args)?;
            run_viewer(
                default_fixture_path().to_owned(),
                Some(load_deep2d(&path)?),
                true,
            )
        }
        Some("--packet-with-deep2d") => {
            let packet_path = args
                .next()
                .map(PathBuf::from)
                .ok_or("--packet-with-deep2d requires a RenderPacket JSON path")?;
            let display_list_path = args
                .next()
                .map(PathBuf::from)
                .ok_or("--packet-with-deep2d requires a Deep2dDisplayList JSON path")?;
            reject_extra(args)?;
            run_viewer(packet_path, Some(load_deep2d(&display_list_path)?), false)
        }
        None => run_viewer(default_fixture_path().to_owned(), None, false),
        Some(argument) => Err(format!("unknown argument {argument:?}; use --help")),
    }
}
