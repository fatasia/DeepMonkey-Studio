use deep_engine_native::contract::{default_fixture_path, load_and_validate};
use std::{ffi::OsString, path::PathBuf};

pub fn execute(
    command: Option<&str>,
    args: &mut impl Iterator<Item = OsString>,
) -> Option<Result<(), String>> {
    if let Some(result) = crate::text_raster_cli::execute(command, args) {
        return Some(result);
    }
    if let Some(result) = crate::asset_package_cli::execute(command, args) {
        return Some(result);
    }
    #[cfg(windows)]
    if command == Some("--smoke-uia") {
        return Some((|| {
            crate::player_cli::reject_extra(args)?;
            let report = deep_engine_native::native_ui::uia_bridge_smoke::run_uia_smoke()?;
            println!("{report}");
            Ok(())
        })());
    }
    #[cfg(not(windows))]
    if command == Some("--smoke-uia") {
        return Some(Err(
            "--smoke-uia requires Windows (UI Automation is not available on this platform)".into(),
        ));
    }
    if command == Some("--smoke-package-selection") {
        return Some((|| {
            let path = crate::player_cli::required_path(args, "--smoke-package-selection")?;
            crate::player_cli::reject_extra(args)?;
            // Exact package only: a rejected candidate must not fall back to cached content.
            let content = crate::runtime_package_startup::load(&path)?.into_content();
            crate::app::run_selection_smoke(content)
        })());
    }
    if command == Some("--smoke-chart-keyboard") {
        return Some((|| {
            let path = crate::player_cli::required_path(args, "--smoke-chart-keyboard")?;
            crate::player_cli::reject_extra(args)?;
            let bytes = std::fs::read(&path)
                .map_err(|error| format!("Cannot read chart {}: {error}", path.display()))?;
            let mut ir = deep_engine_native::chart::parse_chart_ir(&bytes)
                .map_err(|error| format!("Invalid chart: {error:?}"))?;
            // 键盘可达性的前提是存在可聚焦图例项;仓库内 chart 夹具一律
            // legend.visible=false(它们验证几何而非无障碍),因此探针显式打开图例,
            // 等价于用户在界面上展开图例面板。产品夹具与其语义保持不变。
            if !ir.legend.visible {
                ir.legend.visible = true;
                println!(
                    "native chart keyboard smoke: legend was hidden in fixture; enabled for the probe"
                );
            }
            let content = crate::player_content::PlayerContent::from_chart(ir)?;
            crate::app::run_chart_keyboard_smoke(content)
        })());
    }
    if matches!(
        command,
        Some("--chart" | "--smoke-chart" | "--chart-sim" | "--smoke-chart-sim")
    ) {
        return Some((|| {
            let path = crate::player_cli::required_path(args, "--chart")?;
            let sim_path = if matches!(command, Some("--chart-sim" | "--smoke-chart-sim")) {
                Some(crate::player_cli::required_path(args, "sim fixture")?)
            } else {
                None
            };
            crate::player_cli::reject_extra(args)?;
            let bytes = std::fs::read(&path)
                .map_err(|error| format!("Cannot read chart {}: {error}", path.display()))?;
            let ir = deep_engine_native::chart::parse_chart_ir(&bytes)
                .map_err(|error| format!("Invalid chart: {error:?}"))?;
            let mut content = crate::player_content::PlayerContent::from_chart(ir)?;
            if let Some(path) = sim_path {
                let bytes = std::fs::read(&path)
                    .map_err(|error| format!("Cannot read sim {}: {error}", path.display()))?;
                let fixture =
                    deep_engine_native::chart::simulation::parse_chart_sim_fixture(&bytes)?;
                content.chart_sim = Some(crate::player_content::chart_sim::ChartSimHost::new(
                    fixture,
                    content.chart.as_ref().unwrap(),
                )?);
            }
            crate::app::run(
                content,
                matches!(command, Some("--smoke-chart" | "--smoke-chart-sim")),
                false,
                false,
                Default::default(),
            )
        })());
    }
    if command == Some("--headless-chart") {
        return Some((|| {
            let path = crate::player_cli::required_path(args, "--headless-chart")?;
            crate::player_cli::reject_extra(args)?;
            let bytes = std::fs::read(&path)
                .map_err(|error| format!("Cannot read ChartIR {}: {error}", path.display()))?;
            let ir = deep_engine_native::chart::parse_chart_ir(&bytes)
                .map_err(|report| format!("ChartIR validation failed: {:?}", report.diagnostics))?;
            let runtime = deep_engine_native::chart::ChartRuntime::new(ir, 640.0, 360.0)?;
            let ir = runtime.source();
            let state = runtime.state();
            println!(
                "ChartIR structure OK: version={} id={} series={} zooms={} actions={}",
                ir.schema_version,
                ir.id,
                ir.series.len(),
                ir.data_zoom.len(),
                ir.actions.len()
            );
            println!(
                "ChartIR initial state OK: zoom_windows={} selected={}",
                state.zoom_windows.len(),
                state.selected.len()
            );
            println!(
                "ChartIR geometry OK: viewport=640x360 commands={} hit_index=ready",
                runtime.frame().display_list().commands.len()
            );
            Ok(())
        })());
    }
    if !matches!(command, Some("--smoke-selection" | "--smoke-section")) {
        return None;
    }
    Some((|| {
        let path = args
            .next()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_fixture_path().to_owned());
        crate::player_cli::reject_extra(args)?;
        let (packet, _) = load_and_validate(&path)?;
        let content = crate::player_content::PlayerContent::from_packet(packet, None);
        if command == Some("--smoke-section") {
            crate::app::run_section_smoke(content)
        } else {
            crate::app::run_selection_smoke(content)
        }
    })())
}

#[cfg(test)]
mod package_selection_tests {
    use super::*;

    #[test]
    fn package_selection_requires_one_exact_valid_runtime_package_before_window_start() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/runtime-package-coordinate-origin-a.json");
        for args in [
            vec![],
            vec![fixture.into_os_string(), OsString::from("extra")],
            vec![OsString::from("missing-package-selection-fixture.json")],
            vec![default_fixture_path().as_os_str().to_owned()],
        ] {
            assert!(
                execute(Some("--smoke-package-selection"), &mut args.into_iter())
                    .unwrap()
                    .is_err()
            );
        }
    }
}
