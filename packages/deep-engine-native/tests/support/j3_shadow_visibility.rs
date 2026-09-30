use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    cascaded_shadow::{CASCADED_SHADOW_UNIFORM_BYTES, CascadedShadowOptions},
    player_view::PlayerView,
    runtime_package::parse_and_validate_runtime_package,
    scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
#[path = "../../src/shader_package/hash.rs"]
mod hash;
#[path = "j3_hdr_frame.rs"]
mod hdr_frame;

const MANIFEST: &str = include_str!("../../../deep-engine/fixtures/j3-hdr-flat-normal-v1.json");
const PACKAGE: &[u8] = include_bytes!("../fixtures/runtime-package-v1.json");
fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
}

#[test]
#[ignore = "actual production shadow visibility from HDR and matched unshadowed control"]
fn j3_gate_d_actual_shadow_visibility() {
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
        for cascade_count in [2, 4] {
            let options = CascadedShadowOptions {
                cascade_count,
                split_lambda: 0.7,
                max_shadow_distance: 40.0,
                shadow_map_size: 2048,
                depth_padding: 10.0,
                blend_ratio: 0.0,
            };
            for camera in manifest["cameras"].as_array().unwrap() {
                let view = PlayerView {
                    focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan())
                        as f32,
                    near: camera["near"].as_f64().unwrap() as f32,
                    far: 40.0,
                    ..Default::default()
                }
                .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
                .unwrap();
                for shadows_enabled in [true, false] {
                    let scenario = if shadows_enabled {
                        "baseline"
                    } else {
                        "unshadowed-control"
                    };
                    let configure = |frame: &mut deep_engine_native::mesh_abi::FrameUniform| {
                        let lighting: DirectionalLighting = serde_json::from_value(json!({
                            "direction": [-0.6, -0.3, 0.55_f32.sqrt()], "radiance": [2.5, 2.4, 2.25],
                            "exposure": 1.0, "shadows": shadows_enabled
                        })).unwrap();
                        lighting.validate().unwrap().apply(frame);
                        frame[9][3] = 0.0;
                    };
                    for round in 0..2 {
                        let mut uniform_read = None;
                        let mut vp = Vec::new();
                        let mut lighting = Value::Null;
                        let snapshot = render_with_frame_observation(
                            &device,
                            &queue,
                            &content,
                            &mut FrameObservation {
                                size: PhysicalSize::new(width, height),
                                view,
                                configure: Some(&configure),
                                capture_normals: false,
                                shadow_options: Some(options),
                                encode: &mut |device, encoder, targets, frame, shadows| {
                                    assert!(targets.resolved_normal_texture().is_none());
                                    vp = frame[..4].iter().flatten().copied().collect();
                                    lighting = hdr_frame::lighting(frame);
                                    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                                        label: Some("J3 actual Native shadow uniform"),
                                        size: CASCADED_SHADOW_UNIFORM_BYTES,
                                        usage: wgpu::BufferUsages::COPY_DST
                                            | wgpu::BufferUsages::MAP_READ,
                                        mapped_at_creation: false,
                                    });
                                    encoder.copy_buffer_to_buffer(
                                        &shadows.sampling_uniform,
                                        0,
                                        &buffer,
                                        0,
                                        CASCADED_SHADOW_UNIFORM_BYTES,
                                    );
                                    uniform_read = Some(buffer);
                                },
                            },
                        )
                        .await;
                        let uniform_bytes =
                            crate::lod_draw_readback::mapped_bytes(&device, &uniform_read.unwrap());
                        let uniform: Vec<f32> = bytemuck::cast_slice(&uniform_bytes).to_vec();
                        assert_eq!(uniform.len(), 84);
                        assert!(uniform.iter().all(|value| value.is_finite()));
                        assert_eq!(uniform[76], cascade_count as f32);
                        assert_eq!(uniform[78], 1.0 / 2048.0);
                        assert!(
                            snapshot
                                .depths
                                .iter()
                                .all(|depth| depth.is_finite() && (0.0..=1.0).contains(depth))
                        );
                        assert!(snapshot.depths.iter().any(|depth| *depth < 1.0));
                        let map_hash = hash::sha256(bytemuck::cast_slice(&snapshot.depths));
                        let map_non_clear =
                            snapshot.depths.iter().filter(|depth| **depth < 1.0).count();
                        let rgb = hdr_frame::rgb(&snapshot.hdr);
                        let mut samples = Vec::new();
                        for subset in camera["subsets"].as_array().unwrap() {
                            let material = packet["materials"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|m| m["id"] == subset["materialId"])
                                .unwrap();
                            assert!(
                                material.get("emissiveFactor").is_none(),
                                "ratio profile requires no additive emission"
                            );
                            for pixel in subset["pixels"].as_array().unwrap() {
                                let pixel = pixel.as_u64().unwrap() as usize;
                                let hdr = &rgb[pixel * 3..pixel * 3 + 3];
                                assert!(hdr.iter().all(|value| value.is_finite() && *value >= 0.0));
                                if !shadows_enabled {
                                    assert!(hdr.iter().all(|value| *value > 0.0));
                                }
                                samples.push(json!({"pixel":pixel,"instanceId":subset["instanceId"],"hdr":hdr}));
                            }
                        }
                        frames.push(json!({"cameraId":camera["id"],"cascadeCount":cascade_count,"round":round,"scenario":scenario,
                            "actualVP":vp,"lighting":lighting,"shadowUniform":uniform,"shadowUniformAbi":"native-csm-21-vec4",
                            "shadowMapHash":map_hash,"shadowMapSamples":snapshot.depths.len(),"shadowMapNonClear":map_non_clear,"samples":samples}));
                    }
                }
            }
        }
        let evidence = json!({"host":"native-production-mesh-pass","packageHash":manifest["packageHash"],"packetHash":packet_hash,
            "width":width,"height":height,"frames":frames,"gpuErrors":[],"actualHdrAttachments":true,"actualShadowUniform":true,
            "sourceHash":hash::sha256(hdr_frame::shader_source().as_bytes()),"adapter":format!("{info:?}")});
        let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/shadow-visibility");
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(
            output.join("native.json"),
            serde_json::to_string(&evidence).unwrap(),
        )
        .unwrap();
    });
}
