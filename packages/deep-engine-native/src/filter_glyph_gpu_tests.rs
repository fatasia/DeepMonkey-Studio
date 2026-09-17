//! P0-01 filter-slice readback: the TypeScript filter glyph-run display list
//! (test-output/filter-glyph-run-20260918, produced by the P1-18 contract plus
//! native `--measure-glyph-run`) must land real option-text pixels on a real
//! GPU. The proof is an ablation diff: the same list with and without text
//! commands, so background/highlight fills can never fake the assertion.
//!
//! Run with the E2E artifacts present:
//!   FILTER_GLYPH_RUN_DISPLAY_LIST_PATH=test-output/filter-glyph-run-20260918/content-display-list.json \
//!   cargo test -p deep-engine-native --release --lib -- --ignored filter_glyph
//! Optionally set DEEP_DASHBOARD_CAPTURE_DIR for rgba captures.

use deep_engine_native::deep2d::{Deep2dCommand, Deep2dDisplayList, Deep2dRuntimeContent};
use std::sync::Arc;

use crate::chart_gpu_tests::dashboard_composition::draw_in_format_at;
use crate::deep2d_gpu_cache::Deep2dGpuAssetCache;

#[ignore = "requires a real GPU and the TS filter glyph-run artifacts; run explicitly"]
#[test]
fn filter_option_text_pixels_reach_the_gpu_readback() {
    let path = std::env::var_os("FILTER_GLYPH_RUN_DISPLAY_LIST_PATH").unwrap_or_else(|| {
        std::path::PathBuf::from("test-output/filter-glyph-run-20260918/content-display-list.json")
            .into_os_string()
    });
    let bytes = std::fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read the TS filter display list {}: {error}; run \
             FILTER_GLYPH_RUN_E2E=1 pnpm vitest run \
             src/delivery/filterGlyphRunEndToEnd.test.ts in apps/web first",
            path.to_string_lossy()
        )
    });
    let display_list: Deep2dDisplayList =
        serde_json::from_slice(&bytes).expect("parse the TS display list wire format");
    assert!(
        !display_list.atlases.is_empty(),
        "glyph atlas must be registered"
    );
    assert!(
        !display_list.atlases[0].data_base64.is_empty(),
        "glyph atlas must carry pixel data; whether it has real ink is proven by the diff below"
    );

    let text_rects: Vec<[f64; 4]> = display_list
        .commands
        .iter()
        .filter_map(|command| match command {
            Deep2dCommand::Text(text) => {
                assert!(
                    text.baked_glyphs.iter().any(|glyphs| !glyphs.is_empty()),
                    "text commands in this slice must carry baked glyphs"
                );
                let mut x1 = f64::INFINITY;
                let mut y1 = f64::INFINITY;
                let mut x2 = f64::NEG_INFINITY;
                let mut y2 = f64::NEG_INFINITY;
                for glyph in text.baked_glyphs.iter().flatten() {
                    let [dx, dy, dw, dh] = glyph.destination;
                    x1 = x1.min(text.x + dx);
                    y1 = y1.min(text.y + dy);
                    x2 = x2.max(text.x + dx + dw);
                    y2 = y2.max(text.y + dy + dh);
                }
                // 2px logical margin so antialiased edges stay inside.
                Some([x1 - 2.0, y1 - 2.0, x2 - x1 + 4.0, y2 - y1 + 4.0])
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        text_rects.len(),
        4,
        "the filter fixture compiles four option rows"
    );

    // Ablation twin: identical list minus the text commands. Any pixel that
    // differs inside an option row can only come from the measured glyph run.
    let without_text = Deep2dDisplayList {
        commands: display_list
            .commands
            .iter()
            .filter(|command| !matches!(command, Deep2dCommand::Text(_)))
            .cloned()
            .collect(),
        ..display_list.clone()
    };

    let logical = [display_list.logical_width, display_list.logical_height];
    let physical = (960u32, 600u32);
    pollster::block_on(async {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let full = Deep2dRuntimeContent::DisplayList(display_list.clone());
        let ablated = Deep2dRuntimeContent::DisplayList(without_text);
        let with_text_pixels = draw_in_format_at(
            &device,
            &queue,
            &full,
            &cache,
            wgpu::TextureFormat::Rgba8Unorm,
            physical,
        );
        let background_pixels = draw_in_format_at(
            &device,
            &queue,
            &ablated,
            &cache,
            wgpu::TextureFormat::Rgba8Unorm,
            physical,
        );
        assert_ne!(
            with_text_pixels, background_pixels,
            "text commands must change the readback"
        );

        // Evidence capture, same convention as chart_axes_gpu_tests.
        if let Some(directory) = std::env::var_os("DEEP_DASHBOARD_CAPTURE_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("filter-glyph-run.rgba"), &with_text_pixels).unwrap();
            let metadata = serde_json::json!({
                "name": "filter-glyph-run",
                "width": physical.0, "height": physical.1,
                "format": "rgba8unorm", "bytesPerRow": physical.0 * 4,
                "origin": "top-left",
                "displayList": "content-display-list.json",
                "ablation": "same list without text commands",
            });
            std::fs::write(
                directory.join("filter-glyph-run.json"),
                serde_json::to_vec_pretty(&metadata).unwrap(),
            )
            .unwrap();
        }

        for (index, rect) in text_rects.iter().enumerate() {
            let region = super::chart_gpu_tests::dashboard_composition::letterbox_region(
                *rect, logical, physical,
            );
            let (x0, y0, x1, y1) = region;
            let diff = (y0..y1)
                .flat_map(|y| (x0..x1).map(move |x| ((y * physical.0 + x) * 4) as usize))
                .filter(|i| with_text_pixels[*i..*i + 3] != background_pixels[*i..*i + 3])
                .count();
            println!(
                "option row {index} region {region:?}: {diff} glyph pixels differ from the ablated render"
            );
            assert!(
                diff >= 30,
                "option row {index} must show measured text pixels, got {diff}"
            );
        }
        println!(
            "filter glyph run GPU readback OK: {} option rows verified on adapter {:?}",
            text_rects.len(),
            adapter.get_info().name
        );
    });
}
