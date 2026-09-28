//! T01 质量诊断真机接线验证(Windows GPU)。与同族 GPU 测试一致:
//! 默认 `#[ignore]`,经子进程重跑获得真实 surface;CPU 侧合同测试在
//! `quality_telemetry.rs` 内联模块,`cargo test --lib` 常规运行。

use super::*;
use crate::events::RenderOutcome;
use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};
use std::time::Duration;
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

const TEST: &str =
    "renderer::quality_telemetry_gpu_tests::enabled_quality_telemetry_records_presented_frames";

fn lit_content() -> PlayerContent {
    let mut package: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/runtime-package-v1.json")).unwrap();
    let old = package["entrypoints"]["environment"]
        .as_str()
        .unwrap()
        .to_owned();
    package["payloads"].as_object_mut().unwrap().remove(&old);
    package["entrypoints"]["environment"] = json!("scene.environment");
    let value = json!({"schema":"deep-engine.solid-environment","schemaVersion":1,
        "id":"scene.environment","revision":1,"kind":"solid-background-no-ibl",
        "outputTransform":"native-aces-v1","backgroundSrgb":[0.1,0.2,0.3]});
    let hash = runtime_content_sha256(&value);
    package["payloads"]["scene.environment"] = value;
    for resource in package["resources"].as_array_mut().unwrap() {
        if resource["id"] == old {
            resource["id"] = json!("scene.environment");
            resource["contentHash"]["value"] = json!(hash);
        }
    }
    package["resources"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    package["packageHash"]["value"] = json!(runtime_package_sha256(&package).unwrap());
    PlayerContent::from_package(
        parse_and_validate_runtime_package(&serde_json::to_vec(&package).unwrap()).unwrap(),
    )
    .unwrap()
}

#[test]
#[ignore = "requires a real Windows GPU surface; quality telemetry frame counters"]
fn enabled_quality_telemetry_records_presented_frames() {
    const CHILD: &str = "DEEP_QUALITY_TELEMETRY_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--ignored", "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout));
        return;
    }
    let mut builder = EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let mut probe = Probe {
        proxy: event_loop.create_proxy(),
        verified: false,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}

struct Probe {
    proxy: EventLoopProxy<GpuEvent>,
    verified: bool,
}

impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, events: &ActiveEventLoop) {
        let window = std::sync::Arc::new(
            events
                .create_window(
                    crate::app_startup::window_attributes(false)
                        .with_inner_size(winit::dpi::PhysicalSize::new(320, 240)),
                )
                .unwrap(),
        );
        let content = lit_content();
        let features = RendererFeatures {
            bloom: entry_bloom(&content),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: true,
        };
        let mut renderer = pollster::block_on(super::Renderer::new_candidate(
            window,
            self.proxy.clone(),
            1,
            &content,
            content.initial_view(),
            features,
        ))
        .unwrap();
        renderer.activate_surface();
        for _ in 0..3 {
            let mut presented = false;
            for _ in 0..30 {
                match renderer.render_internal(false, true) {
                    RenderOutcome::Presented => {
                        presented = true;
                        break;
                    }
                    RenderOutcome::Skipped => std::thread::sleep(Duration::from_millis(10)),
                    RenderOutcome::Failed(error) => panic!("GPU frame failed: {error}"),
                    _ => panic!("GPU surface recovery unexpectedly required"),
                }
            }
            assert!(presented, "surface never presented");
        }
        let report = renderer
            .quality_report()
            .expect("enabled quality telemetry must report recorded frames");
        assert_eq!(report["schema"], "deep-engine.quality-telemetry");
        assert_eq!(report["version"], 1);
        assert_eq!(report["retainedFrameCount"], 3);
        // 每个最小 presented 帧至少含 opaque 与 output 两个 pass 边界。
        let total_passes = report["totals"]["passCount"].as_u64().unwrap();
        assert!(
            total_passes >= 6,
            "expected >= 6 pass boundaries over 3 frames, got {total_passes}"
        );
        // visibleInstances 按真机 HiZ 实际开关分支:关闭 → 全帧 null(未测量,
        // 禁止伪零);Auto 且设备支持 → 读回成熟帧必须给出 drawn 且不超过候选。
        let hiz_on = hi_z_pyramid::occlusion_hiz_enabled();
        let candidates = renderer.culling_summary().candidate_instances;
        let measured = report["totals"]["framesWithMeasuredVisibleInstances"]
            .as_u64()
            .unwrap();
        for frame in report["frames"].as_array().unwrap() {
            assert!(frame["passCount"].as_u64().unwrap() >= 2);
            assert_eq!(frame["adaptiveDecisions"], 0);
            if !hiz_on {
                assert!(frame["visibleInstances"].is_null());
            } else if let Some(drawn) = frame["visibleInstances"].as_u64() {
                assert!(
                    drawn <= u64::from(candidates),
                    "drawn {drawn} must not exceed candidates {candidates}"
                );
            }
        }
        if hiz_on {
            // 读回比提交晚一帧以上:末帧前必须有成熟样本,否则读回链未接。
            assert!(
                measured >= 1,
                "HiZ enabled but no visible-instance readback matured"
            );
        } else {
            assert_eq!(measured, 0);
        }
        // 测试进程未设置 DEEP_ENGINE_QUALITY_PROFILE:活动档必须是 null,
        // 不得伪造默认档名。
        assert!(report["activeProfile"].is_null());
        assert_eq!(
            report["coverage"]["uploadedBytes"],
            "renderer-direct-queue-writes"
        );
        self.verified = true;
        events.exit();
    }
    fn window_event(
        &mut self,
        _: &ActiveEventLoop,
        _: winit::window::WindowId,
        _: winit::event::WindowEvent,
    ) {
    }
}
