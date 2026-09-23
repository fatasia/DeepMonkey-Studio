//! 真实 TS v6→LPAC 会话→Deep2D GPU；离屏证据，不替代窗口视觉验收。
#![cfg(windows)]
#![allow(dead_code)]
#[path = "../src/deep2d_atlas_gpu.rs"]
mod deep2d_atlas_gpu;
#[path = "../src/deep2d_gpu.rs"]
mod deep2d_gpu;
// deep2d_gpu.rs 的 Windows 绘制签名引用本模块（#[path] 重组装的 bin 侧模块族）。
#[path = "../src/dashboard_video_gpu.rs"]
mod dashboard_video_gpu;
#[path = "../src/deep2d_gpu_cache.rs"]
mod deep2d_gpu_cache;
#[path = "../src/deep2d_scissor.rs"]
mod deep2d_scissor;
#[path = "support/deep2d_mixed_content_fixture.rs"]
mod fixture;
#[path = "support/deep2d_mixed_content_gpu_readback.rs"]
mod readback;
#[path = "support/compat_x_text_trace.rs"]
mod text_trace;

use deep_engine_native::{
    compat_x::{
        process::{XProcessConfig, lpac::Session},
        scheduler::{XTickBinding, bind_tick},
        *,
    },
    deep2d::Deep2dRuntimeContent,
    runtime_package::parse_and_validate_x_runtime_package,
};
use std::sync::Arc;
const WIDTH: u32 = 320;
const HEIGHT: u32 = 180;
const ROW_PIXELS: usize = 320;
const BG: [u8; 4] = [255, 0, 0, 255];

fn verify_triangle(pixels: &[[u8; 4]]) -> usize {
    let mut interior = 0;
    for y in 0..HEIGHT as usize {
        for x in 0..WIDTH as usize {
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            let left = 10.0 + (py - 10.0) * 35.0 / 60.0;
            let right = 80.0 - (py - 10.0) * 35.0 / 60.0;
            // 独立解析三角形真值；边缘 1 px 留给光栅化覆盖规则。
            if py > 11.0 && py < 69.0 && px > left + 1.0 && px < right - 1.0 {
                for (actual, expected) in pixels[y * WIDTH as usize + x]
                    .iter()
                    .zip([26_u8, 179, 230, 255])
                {
                    assert!(actual.abs_diff(expected) <= 1, "interior ({x},{y})");
                }
                interior += 1;
            } else if !(9.0..=71.0).contains(&py) || px < left - 1.0 || px > right + 1.0 {
                assert_eq!(pixels[y * WIDTH as usize + x], BG, "outside ({x},{y})");
            }
        }
    }
    assert!(interior > 1_900);
    interior
}

#[test]
#[ignore = "requires real GPU and static CRT X worker; run explicitly"]
fn author_package_lpac_output_draws_exact_geometry_and_cancel_keeps_old_gpu_frame() {
    let loaded = parse_and_validate_x_runtime_package(include_bytes!(
        "../../deep-engine/fixtures/experimental-x-display-runtime-v6.json"
    ))
    .unwrap();
    let worker = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/x_compat_worker.exe");
    let config = XProcessConfig {
        enabled: true,
        budget: XBudget {
            max_wall_clock_ms: 5_000,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut session = Session::start(&worker, config).unwrap();
    let host = XCompatibilityHost::new(true, config.budget).unwrap();
    pollster::block_on(async {
        let (device, queue, adapter) = readback::gpu_device().await;
        let cache = Arc::new(deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let mut previous = None;
        let mut first_pixels = None;
        for epoch in 9..=10 {
            let content = bind_tick(
                &loaded.content,
                XTickBinding {
                    epoch,
                    started_at_ms: 200 + (epoch - 9) * 16,
                    random_seed: epoch,
                    events: vec![],
                },
                config.budget,
            )
            .unwrap();
            let context = XExecutionContext {
                current_epoch: epoch,
                now_ms: content.request.started_at_ms,
                cancelled: false,
            };
            let candidate = session.evaluate(&content.request, || context).unwrap();
            let messages = host
                .publish(CompatibilityLane::ExperimentalX, candidate, context)
                .unwrap();
            let [XMessage::DisplayList(display)] = messages.as_slice() else {
                panic!("one display layer required")
            };
            let runtime = Deep2dRuntimeContent::DisplayList(display.as_ref().clone());
            let painter = if let Some(active) = previous.as_ref() {
                deep2d_gpu::Deep2dGpuPainter::stage_update(
                    active,
                    &device,
                    &queue,
                    wgpu::TextureFormat::Rgba8Unorm,
                    &runtime,
                )
                .unwrap()
            } else {
                deep2d_gpu::Deep2dGpuPainter::new(
                    &device,
                    &queue,
                    wgpu::TextureFormat::Rgba8Unorm,
                    &runtime,
                    &cache,
                )
                .unwrap()
            };
            let pixels = readback::draw_and_read(&painter, &device, &queue, "X published layer");
            let interior = verify_triangle(&pixels);
            if let Some(first) = &first_pixels {
                assert_eq!(&pixels, first);
            }
            first_pixels = Some(pixels);
            previous = Some(painter);
            println!("X GPU adapter={adapter} epoch={epoch} independentInteriorPixels={interior}");
        }
        let rejected = session.evaluate(&loaded.content.request, || XExecutionContext {
            current_epoch: 9,
            now_ms: 200,
            cancelled: true,
        });
        assert!(rejected.is_err());
        let kept = readback::draw_and_read(
            previous.as_ref().unwrap(),
            &device,
            &queue,
            "X rejected candidate keeps frame",
        );
        assert_eq!(Some(kept), first_pixels);
    });
    session.close().unwrap();
}
