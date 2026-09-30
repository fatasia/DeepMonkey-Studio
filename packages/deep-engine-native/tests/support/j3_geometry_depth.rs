use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    half_decode::half_to_f32, player_view::PlayerView,
    runtime_package::parse_and_validate_runtime_package,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
#[path = "j3_geometry_depth_readback.rs"]
mod depth_readback;
#[path = "../../src/shader_package/hash.rs"]
mod hash;
const MANIFEST: &str = include_str!("../../../deep-engine/fixtures/j3-geometry-depth-v1.json");
const PACKAGE: &[u8] = include_bytes!("../fixtures/runtime-package-v1.json");
fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
}

#[test]
#[ignore = "actual production same-packet same-camera geometry/main-depth readback"]
fn j3_gate_d_actual_geometry_depth() {
    pollster::block_on(async {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let package: Value = serde_json::from_slice(PACKAGE).unwrap();
        let packet = &package["payloads"][package["entrypoints"]["renderPacket"].as_str().unwrap()];
        let packet_hash = hash::sha256(&serde_json::to_vec(packet).unwrap());
        assert_eq!(packet_hash, manifest["packetHash"].as_str().unwrap());
        let loaded = parse_and_validate_runtime_package(PACKAGE).unwrap();
        assert_eq!(
            loaded.package_hash,
            manifest["packageHash"].as_str().unwrap()
        );
        let content = PlayerContent::from_package(loaded).unwrap();
        let width = manifest["width"].as_u64().unwrap() as u32;
        let height = manifest["height"].as_u64().unwrap() as u32;
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real hardware GPU");
        let info = adapter.get_info();
        assert!(matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        let mut frames = Vec::new();
        for camera in manifest["cameras"].as_array().unwrap() {
            assert_eq!(vector(&camera["up"]), [0.0, 1.0, 0.0]);
            let view = PlayerView {
                focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan()) as f32,
                near: camera["near"].as_f64().unwrap() as f32,
                far: camera["far"].as_f64().unwrap() as f32,
                ..Default::default()
            }
            .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
            .unwrap();
            for round in 0..2 {
                let mut readback = None;
                let mut vp = Vec::new();
                let snapshot = render_with_frame_observation(
                    &device,
                    &queue,
                    &content,
                    &mut FrameObservation {
                        size: PhysicalSize::new(width, height),
                        view,
                        encode: &mut |device, encoder, targets, frame| {
                            vp = frame[..4].iter().flatten().copied().collect();
                            readback = Some(depth_readback::encode(
                                device,
                                encoder,
                                &targets.depth_view,
                                width,
                                height,
                            ));
                        },
                    },
                )
                .await;
                let bytes = crate::lod_draw_readback::mapped_bytes(&device, &readback.unwrap());
                let depth: Vec<f32> = bytemuck::cast_slice(&bytes).to_vec();
                assert!(
                    depth[..4].iter().all(|v| *v >= 1.0 - 1e-7),
                    "production corner depth must remain far clear, not discarded zero"
                );
                assert!(
                    depth
                        .iter()
                        .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
                );
                assert!(depth.iter().filter(|v| **v < 1.0).count() > 64);
                let background: Vec<_> = snapshot.hdr[..6]
                    .chunks_exact(2)
                    .map(|v| half_to_f32(u16::from_le_bytes([v[0], v[1]])))
                    .collect();
                let mut hdr_non_background = 0;
                for pixel in snapshot.hdr.chunks_exact(8) {
                    let channels: Vec<_> = pixel
                        .chunks_exact(2)
                        .map(|v| half_to_f32(u16::from_le_bytes([v[0], v[1]])))
                        .collect();
                    assert!(channels.iter().all(|v| v.is_finite()));
                    if channels[..3]
                        .iter()
                        .zip(&background)
                        .any(|(v, clear)| (v - clear).abs() > 0.001)
                    {
                        hdr_non_background += 1;
                    }
                }
                assert!(hdr_non_background > 32);
                frames.push(json!({"cameraId":camera["id"],"round":round,"depthSamples":4,"vp":vp,"depth":depth,"hdrNonBackground":hdr_non_background}));
            }
        }
        let evidence = json!({"host":"native-production-mesh-pass","packageHash":manifest["packageHash"],
            "packetHash":packet_hash,"width":width,"height":height,"frames":frames,"passed":true,"adapter":format!("{info:?}")});
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/geometry-depth");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            out.join("native.json"),
            serde_json::to_string(&evidence).unwrap(),
        )
        .unwrap();
    });
}
