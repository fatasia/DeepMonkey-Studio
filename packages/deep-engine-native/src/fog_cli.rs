use std::{ffi::OsString, path::PathBuf};

use deep_engine_native::{
    contract::{default_fixture_path, load_and_validate},
    fog::FogSettings,
};

use crate::{app, player_content::PlayerContent};

pub fn run(
    mut args: impl Iterator<Item = OsString>,
    smoke: bool,
    headless: bool,
) -> Result<(), String> {
    let density = required_number(&mut args, "density")?;
    let color = [
        required_number(&mut args, "red")?,
        required_number(&mut args, "green")?,
        required_number(&mut args, "blue")?,
    ];
    let path = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| default_fixture_path().to_owned());
    crate::player_cli::reject_extra(args)?;
    let fog = FogSettings::exponential(density, color)?;
    let (packet, summary) = load_and_validate(&path)?;
    println!(
        "native fog preflight OK: mode=exponential density={} color={:?} geometries={} instances={} triangles={}",
        fog.density(),
        fog.color(),
        summary.geometries,
        summary.instances,
        summary.triangles
    );
    if headless {
        return Ok(());
    }
    app::run_fog(PlayerContent::from_packet(packet, None), smoke, fog)
}

fn required_number(args: &mut impl Iterator<Item = OsString>, name: &str) -> Result<f32, String> {
    let value = args
        .next()
        .ok_or_else(|| format!("fog requires density red green blue; missing {name}"))?;
    let text = value
        .to_str()
        .ok_or_else(|| format!("fog {name} must be valid Unicode"))?;
    text.parse::<f32>()
        .map_err(|_| format!("fog {name} must be a number, got {text:?}"))
}
