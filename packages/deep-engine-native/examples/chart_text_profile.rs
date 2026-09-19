//! CPU-only composition profiler; uses the exact performance fixture and production layers.
use deep_engine_native::{
    chart::{ChartRuntime, axis_render, legend_render, state_render, tooltip_render},
    native_ui::design_tokens::DesignTokenSnapshot,
    platform_text::TextRasterizer,
};
use std::time::Instant;
const ROWS: usize = 8192;
#[path = "../tests/support/chart_e2e_fixture.rs"]
#[allow(dead_code)]
mod fixture;

fn main() {
    let chart = ChartRuntime::new(fixture::make_ir(0), 1280.0, 720.0).unwrap();
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    let mut rasterizer = TextRasterizer::new();
    let mut stages = [0_u128; 4];
    let mut profiles = Vec::new();
    for index in 0..35 {
        rasterizer.start_profile();
        let start = Instant::now();
        let mut list = tooltip_render::compose_tooltip(
            &chart,
            &mut rasterizer,
            &tokens.themes.dark,
            [640.0, 360.0],
        )
        .unwrap();
        let composition = start.elapsed().as_nanos();
        let start = Instant::now();
        axis_render::append_axes(&mut list, &chart, &mut rasterizer, &tokens.themes.dark).unwrap();
        let axes = start.elapsed().as_nanos();
        let start = Instant::now();
        state_render::append_state_outlines(&mut list, &chart, &tokens.themes.dark).unwrap();
        let state = start.elapsed().as_nanos();
        let start = Instant::now();
        legend_render::append_legend(
            &mut list,
            &chart,
            &mut rasterizer,
            &tokens.themes.dark,
            0,
            None,
        )
        .unwrap();
        let legend = start.elapsed().as_nanos();
        if index >= 5 {
            for (sum, elapsed) in stages.iter_mut().zip([composition, axes, state, legend]) {
                *sum += elapsed;
            }
            profiles.push(rasterizer.profile().unwrap().clone());
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "scope":"CPU-only 8x8192 unchanged chart composition; 5 warmup/30 measured; no GPU; see build conditions for linker mode",
            "stage_total_nanos":{"geometry_clone_tooltip":stages[0],"axes":stages[1],"state":stages[2],"legend":stages[3]},
            "text_profiles":profiles,
        })
    );
}
