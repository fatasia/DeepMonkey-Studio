//! Real-GPU readback proving the presenter-layer axis labels, y ticks and
//! legend swatches actually land pixels through the production painter.

use super::dashboard_composition::{colored_in_region, draw_in_format_at, letterbox_region};
use super::{Deep2dGpuAssetCache, gpu_context};
use deep_engine_native::chart::{
    ChartRuntime, axis_render, parse_chart_ir, presentation::present_chart,
};
use deep_engine_native::deep2d::{Deep2dCommand, Deep2dRuntimeContent};
use deep_engine_native::platform_text::TextRasterizer;
use deep_engine_native::runtime_package::parse_and_validate_runtime_package;
use serde_json::json;
use std::sync::Arc;

fn fixture_ir() -> ChartRuntime {
    let ir = parse_chart_ir(
        &serde_json::to_vec(
            &json!({"schemaVersion":1,"sourceSpecVersion":1,"id":"axes-gpu",
            "datasets":[{"id":"d","dimensions":["category","value"],
                "rows":[["华东",37],["华北",91],["华南",58]]}],
            "axes":[{"id":"axis.x","channel":"x","scale":"category","min":null,"max":null},
                {"id":"axis.y","channel":"y","scale":"linear","min":null,"max":null}],
            "series":[{"id":"series.0","label":"分区域出力","type":"bar","datasetId":"d",
                "x":"category","y":"value","xAxisId":"axis.x","yAxisId":"axis.y"}],
            "legend":{"visible":true,"position":"top"},
            "tooltip":{"enabled":true,"trigger":"axis"},"dataZoom":[],"actions":[]}),
        )
        .unwrap(),
    )
    .unwrap();
    ChartRuntime::new(ir, 440.0, 430.0).unwrap()
}

fn presented(chart: &ChartRuntime) -> Deep2dRuntimeContent {
    let mut rasterizer = TextRasterizer::new();
    Deep2dRuntimeContent::DisplayList(
        present_chart(chart, &mut rasterizer, 0, [0.0, 0.0], None).unwrap(),
    )
}

/// Count of light text-like pixels (the axis label token is a light gray;
/// bar green and the dark background never reach this brightness).
fn text_pixels(pixels: &[u8], physical: (u32, u32), region: (u32, u32, u32, u32)) -> usize {
    let (x0, y0, x1, y1) = region;
    (y0..y1)
        .flat_map(|y| (x0..x1).map(move |x| ((y * physical.0 + x) * 4) as usize))
        .filter(|i| pixels[*i] > 120 && pixels[*i + 1] > 120 && pixels[*i + 2] > 120)
        .count()
}

fn capture_rgba(name: &str, pixels: &[u8], physical: (u32, u32)) {
    let Some(directory) = std::env::var_os("DEEP_DASHBOARD_CAPTURE_DIR") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("{name}.rgba")), pixels).unwrap();
    let metadata = serde_json::json!({
        "name": name,
        "width": physical.0,
        "height": physical.1,
        "format": "rgba8unorm",
        "bytesPerRow": physical.0 * 4,
        "origin": "top-left"
    });
    std::fs::write(
        directory.join(format!("{name}.json")),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .unwrap();
}

#[ignore = "requires a real GPU; run explicitly with --ignored"]
#[test]
fn axis_labels_y_ticks_and_legend_swatches_land_pixels() {
    let chart = fixture_ir();
    let content = presented(&chart);
    let physical = (880u32, 860u32);
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let pixels = draw_in_format_at(
            &device,
            &queue,
            &content,
            &cache,
            wgpu::TextureFormat::Rgba8Unorm,
            physical,
        );
        capture_rgba("axes-legend-local", &pixels, physical);
        // X tick label band: the plot bottom edge rides the canvas bottom.
        let x_band = letterbox_region([8.0, 400.0, 424.0, 30.0], [440.0, 430.0], physical);
        let x_text = text_pixels(&pixels, physical, x_band);
        println!("x label band {x_band:?}: {x_text} text pixels");
        assert!(x_text > 60, "category labels must render, got {x_text}");
        // Y tick column: left edge of the plot.
        let y_band = letterbox_region([8.0, 32.0, 30.0, 390.0], [440.0, 430.0], physical);
        let y_text = text_pixels(&pixels, physical, y_band);
        println!("y tick band {y_band:?}: {y_text} text pixels");
        assert!(y_text > 30, "y tick labels must render, got {y_text}");
        // Legend band at the top: swatch green plus label text.
        let legend_band = letterbox_region([0.0, 0.0, 440.0, 24.0], [440.0, 430.0], physical);
        let legend_any = colored_in_region(&pixels, physical, legend_band);
        assert!(legend_any > 60, "legend must render, got {legend_any}");
        // First legend item at [8,8,104,24]: chip inset 6px, 10px wide.
        let scale_f = f64::from(physical.0) / 440.0;
        let chip = (
            (12.0 * scale_f).floor() as u32,
            (12.0 * scale_f).floor() as u32,
            (26.0 * scale_f).ceil() as u32,
            (26.0 * scale_f).ceil() as u32,
        );
        let chip_green = colored_in_region(&pixels, physical, chip);
        assert!(chip_green > 0, "first legend swatch chip must paint");
        // Axis lines: a horizontal stroke near the plot bottom.
        let axis_line = letterbox_region([8.0, 421.0, 424.0, 3.0], [440.0, 430.0], physical);
        assert!(
            colored_in_region(&pixels, physical, axis_line) > 300,
            "x axis line must stroke the plot bottom"
        );
    });
}

/// Producer-package proof: the exact runtime package from the P0-06
/// acceptance run must show 华东/华北/华南 tick labels in a letterboxed
/// window. Legend stays off because the package IR says `visible: false`.
#[ignore = "requires a real GPU and DEEP_DASHBOARD_PACKAGE_PATH pointing at a producer runtime package"]
#[test]
fn producer_package_axis_labels_reach_the_window() {
    use deep_engine_native::dashboard_runtime::DashboardRuntime;
    let bytes = std::fs::read(std::env::var_os("DEEP_DASHBOARD_PACKAGE_PATH").expect(
        "set DEEP_DASHBOARD_PACKAGE_PATH to a producer runtime package              (e.g. test-output/dashboard-http-multicomponent-*/extracted/runtime-package.json)",
    ))
    .expect("read producer package");
    let package = parse_and_validate_runtime_package(&bytes).expect("validate producer package");
    let loaded = package.dashboard.expect("dashboard entrypoint");
    let node_frame = {
        let node = loaded
            .document
            .pages
            .iter()
            .flat_map(|page| &page.nodes)
            .find(|node| node.chart.is_some())
            .expect("package must carry a chart node");
        node.frame
    };
    let physical = (1200u32, 800u32);
    let mut runtime = DashboardRuntime::new(loaded).expect("prepare producer dashboard");
    let page_id = runtime.active_page_id().to_string();
    runtime.switch_page(&page_id).unwrap();
    let node_id = runtime
        .document()
        .pages
        .iter()
        .flat_map(|page| &page.nodes)
        .find(|node| node.chart.is_some())
        .map(|node| node.id.clone())
        .expect("chart node");
    let chart = runtime.chart(&node_id).expect("chart runtime").clone();
    let mut rasterizer = TextRasterizer::new();
    let list = present_chart(&chart, &mut rasterizer, 0, [0.0, 0.0], None).unwrap();
    let labels: Vec<[f64; 4]> = list
        .commands
        .iter()
        .filter_map(|command| match command {
            Deep2dCommand::Image(image) if image.z_order == axis_render::AXIS_TEXT_Z => {
                Some([image.x, image.y, image.width, image.height])
            }
            _ => None,
        })
        .collect();
    assert!(
        !labels.is_empty(),
        "producer chart must present axis label quads"
    );
    // The package IR disables its legend; that semantic must be respected.
    assert!(!list.commands.iter().any(|command| matches!(command,
        Deep2dCommand::Image(image) if image.z_order == i32::MAX - 2)));
    let page = runtime.document().pages[0].clone();
    let logical = [page.width, page.height];
    let content = runtime.content().clone();
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let pixels = draw_in_format_at(
            &device,
            &queue,
            &content,
            &cache,
            wgpu::TextureFormat::Rgba8Unorm,
            physical,
        );
        capture_rgba("producer-axes-legend", &pixels, physical);
        // Each axis label quad, translated into page space, must contain
        // rendered text pixels in the letterboxed window.
        let mut checked = 0usize;
        for rect in &labels {
            let page_rect = [
                node_frame[0] + rect[0],
                node_frame[1] + rect[1],
                rect[2],
                rect[3],
            ];
            let region = letterbox_region(page_rect, logical, physical);
            let text = text_pixels(&pixels, physical, region);
            assert!(
                text > 3,
                "axis label quad {page_rect:?} rendered only {text} text pixels"
            );
            checked += 1;
        }
        println!("producer package: {checked} axis label quads verified in-window");
        assert!(checked >= 4, "expected category + y ticks, got {checked}");
    });
}
