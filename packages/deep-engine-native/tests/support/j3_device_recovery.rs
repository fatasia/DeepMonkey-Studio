use crate::{
    fixture, render,
    shader_material_assertions::{color_changes, depth_changes},
};
use deep_engine_native::half_decode::half_to_f32;
use serde_json::{Value, json};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

#[allow(dead_code)]
#[path = "../../src/shader_package/hash.rs"]
mod hash;

const MANIFEST: &str = include_str!("../../../deep-engine/fixtures/j3-device-recovery-v1.json");
const PACKAGE: &str = include_str!("../fixtures/runtime-package-shader-v2.json");

fn valid(snapshot: &crate::shader_material_renderer::Snapshot) -> usize {
    assert!(!snapshot.hdr.is_empty());
    // This fixture uses ForwardTargets::new(..., None): verify the actual corner
    // is the production clear, then count geometry relative to that readback.
    let background: Vec<_> = snapshot.hdr[..6]
        .chunks_exact(2)
        .map(|lane| half_to_f32(u16::from_le_bytes([lane[0], lane[1]])))
        .collect();
    for (actual, clear) in background.iter().zip([0.012, 0.020, 0.035]) {
        assert!(
            (actual - clear).abs() < 0.001,
            "fixture corner must be clear HDR"
        );
    }
    let mut colored = 0;
    for pixel in snapshot.hdr.chunks_exact(8) {
        let channels: Vec<_> = pixel
            .chunks_exact(2)
            .map(|lane| half_to_f32(u16::from_le_bytes([lane[0], lane[1]])))
            .collect();
        assert!(channels.iter().all(|value| value.is_finite()));
        if channels[..3]
            .iter()
            .zip(&background)
            .any(|(value, clear)| (value - clear).abs() > 0.001)
        {
            colored += 1;
        }
    }
    assert!(
        colored > 32
            && snapshot
                .commands
                .first()
                .expect("production draw commands")
                .iter()
                .map(|draw| draw[1])
                .sum::<u32>()
                > 0
    );
    assert!(snapshot.depths.iter().all(|value| value.is_finite()));
    assert!(
        snapshot.depths.iter().filter(|value| **value < 1.0).count() > 32,
        "production CSM must contain geometry depth, not only clear"
    );
    colored
}

#[test]
#[ignore = "actual hardware device destroy/recreate and production frame readback"]
fn j3_gate_e_actual_device_recovery() {
    pollster::block_on(async {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let package: Value = serde_json::from_str(PACKAGE).unwrap();
        let packet = &package["payloads"][package["entrypoints"]["renderPacket"].as_str().unwrap()];
        let packet_hash = hash::sha256(&serde_json::to_vec(packet).unwrap());
        assert_eq!(packet_hash, manifest["packetHash"].as_str().unwrap());
        let content = fixture();
        assert_eq!(
            content.runtime_package().unwrap().package_hash,
            manifest["packageHash"].as_str().unwrap()
        );
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let info = adapter.get_info();
        assert!(matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let mut runs = Vec::new();
        for _ in 0..2 {
            let mut phases = Vec::new();
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let (sender, receiver) = mpsc::sync_channel(1);
            device.set_device_lost_callback(move |reason, _| {
                let _ = sender.send(reason);
            });
            phases.push("initial-device");
            let started = Instant::now();
            let mut colored = 0;
            let mut observed_live = false;
            let before = crate::shader_material_renderer::render_with_live_components(
                &device, &queue, &content, &mut |snapshot| {
                    assert!(started.elapsed() < Duration::from_millis(manifest["frameTimeoutMs"].as_u64().unwrap()));
                    phases.push("uploaded");
                    colored = valid(snapshot); phases.push("first-valid-frame");
                    // The production helper still owns scene/CSM/targets/pipelines/culling/LOD here.
                    device.destroy(); let _ = device.poll(wgpu::PollType::Poll);
                    let reason = receiver.recv_timeout(Duration::from_millis(manifest["lostTimeoutMs"].as_u64().unwrap()))
                        .expect("actual device lost callback must arrive while production owners are live");
                    assert_eq!(reason, wgpu::DeviceLostReason::Destroyed);
                    observed_live = true; phases.push("lost-observed");
                }
            ).await;
            assert!(observed_live);
            drop(queue);
            drop(device);
            phases.push("old-host-retired");
            let (replacement, replacement_queue) =
                adapter.request_device(&Default::default()).await.unwrap();
            phases.push("recreated");
            let started = Instant::now();
            let after = render(&replacement, &replacement_queue, &content, false).await;
            assert!(
                started.elapsed()
                    < Duration::from_millis(manifest["frameTimeoutMs"].as_u64().unwrap())
            );
            phases.push("uploaded");
            valid(&after);
            phases.push("first-valid-frame");
            assert_eq!(color_changes(&before, &after), 0);
            assert_eq!(depth_changes(&before, &after), [0; 4]);
            replacement.destroy();
            drop(replacement_queue);
            drop(replacement);
            phases.push("disposed");
            assert_eq!(json!(phases), manifest["phases"]);
            runs.push(json!({"phases":phases,"lossReason":"destroyed","newDevice":true,
                "firstFrameValid":true,"firstFrameStable":true,"liveComponentsAtLoss":observed_live,"coloredPixels":colored,"maxError":0}));
        }
        let evidence = json!({"host":"native-production-render-components","packageHash":manifest["packageHash"],
            "packetHash":packet_hash,"runs":runs,"passed":true,"adapter":format!("{info:?}"),
            "scope":"actual destroyed-device reopen + GpuScene/HDR/CSM; not NativeApp window event routing"});
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/device-recovery");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            out.join("native.json"),
            serde_json::to_string_pretty(&evidence).unwrap(),
        )
        .unwrap();
        println!("{evidence}");
    });
}
