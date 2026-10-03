use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    cascaded_shadow::CascadedShadowOptions,
    player_view::PlayerView,
    runtime_package::{parse_and_validate_runtime_package, runtime_content_sha256},
    scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
#[path = "../../src/shader_package/hash.rs"]
mod hash;
#[path = "j3_hdr_frame.rs"]
mod hdr_frame;
#[path = "j3_fullscene_readback.rs"]
mod readback;
fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
}

#[test]
#[ignore = "actual shared industrial fullscene package, two hardware devices, complete product output"]
fn j3_gate_d_actual_industrial_fullscene() {
    pollster::block_on(async {
        let bytes =
            std::fs::read(std::env::var("J3_FULLSCENE_INPUT_PATH").expect("frozen input required"))
                .unwrap();
        let input: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(input["schema"], "j3-industrial-fullscene-plan-v1");
        let f = &input["profile"];
        assert_eq!(f["id"], "t00-complete-bay-and-pressure-vessel-v1");
        let width = input["width"].as_u64().unwrap() as u32;
        let height = input["height"].as_u64().unwrap() as u32;
        assert_eq!((width, height), (512, 512));
        assert_eq!(input["cameras"].as_array().unwrap().len(), 2);
        assert_eq!(input["admission"]["instanceCount"], 27);
        let mut runs = vec![];
        for fresh in 0..2 {
            let instance =
                wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    force_fallback_adapter: false,
                    ..Default::default()
                })
                .await
                .unwrap();
            let info = adapter.get_info();
            assert!(matches!(
                info.device_type,
                wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
            ));
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let mut frames = vec![];
            for scenario in input["scenarioPackages"].as_array().unwrap() {
                let pkg = parse_and_validate_runtime_package(
                    scenario["packageText"].as_str().unwrap().as_bytes(),
                )
                .unwrap();
                assert_eq!(pkg.package_hash, scenario["packageHash"].as_str().unwrap());
                let key = scenario["package"]["entrypoints"]["renderPacket"]
                    .as_str()
                    .unwrap();
                assert_eq!(
                    runtime_content_sha256(&scenario["package"]["payloads"][key]),
                    scenario["packetHash"].as_str().unwrap()
                );
                let content = PlayerContent::from_package(pkg).unwrap();
                for camera in input["cameras"].as_array().unwrap() {
                    let view = PlayerView {
                        focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan())
                            as f32,
                        near: camera["near"].as_f64().unwrap() as f32,
                        far: camera["far"].as_f64().unwrap() as f32,
                        ..Default::default()
                    }
                    .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
                    .unwrap();
                    for round in 0..2 {
                        let configure = |frame: &mut deep_engine_native::mesh_abi::FrameUniform| {
                            let lighting: DirectionalLighting = serde_json::from_value(json!({
                                "direction":f["surfaceToLight"], "radiance":f["radiance"], "exposure":f["exposure"], "shadows":true
                            })).unwrap();
                            lighting.validate().unwrap().apply(frame);
                            frame[9][3] = 0.0;
                        };
                        let mut captured = None;
                        let mut vp = vec![];
                        let mut lighting = Value::Null;
                        let snapshot = render_with_frame_observation(
                            &device,
                            &queue,
                            &content,
                            &mut FrameObservation {
                                capture_normals: true,
                                size: PhysicalSize::new(width, height),
                                view,
                                configure: Some(&configure),
                                shadow_options: Some(CascadedShadowOptions {
                                    cascade_count: 4,
                                    shadow_map_size: 2048,
                                    max_shadow_distance: 40.0,
                                    split_lambda: 0.7,
                                    depth_padding: 10.0,
                                    blend_ratio: 0.0,
                                }),
                                encode: &mut |device, encoder, targets, frame, shadows| {
                                    vp = frame[..4].iter().flatten().copied().collect();
                                    lighting = hdr_frame::lighting(frame);
                                    captured = Some(readback::encode(
                                        device, encoder, targets, shadows, width, height,
                                    ));
                                },
                            },
                        )
                        .await;
                        let captured = captured.unwrap();
                        let depth_bytes =
                            crate::lod_draw_readback::mapped_bytes(&device, &captured.depth);
                        let depth: Vec<f32> = bytemuck::cast_slice(&depth_bytes).to_vec();
                        let normals: Vec<f32> =
                            crate::lod_draw_readback::mapped_bytes(&device, &captured.normals)
                                .iter()
                                .map(|v| f32::from(*v) / 255.0)
                                .collect();
                        let display =
                            crate::lod_draw_readback::mapped_bytes(&device, &captured.display);
                        let uniform_bytes = crate::lod_draw_readback::mapped_bytes(
                            &device,
                            &captured.shadow_uniform,
                        );
                        let uniform: Vec<f32> = bytemuck::cast_slice(&uniform_bytes).to_vec();
                        let hdr = hdr_frame::rgb(&snapshot.hdr);
                        assert!(hdr.iter().all(|v| v.is_finite()));
                        let nonclear = depth
                            .chunks_exact(4)
                            .filter(|samples| samples.iter().any(|v| *v < 1.0 - 1e-7))
                            .count();
                        assert!(nonclear > 256);
                        let shadow_nonclear =
                            snapshot.depths.iter().filter(|v| **v < 1.0 - 1e-7).count();
                        assert!(shadow_nonclear > 0);
                        frames.push(json!({"cameraId":camera["id"], "scenario":scenario["id"], "round":round,
                            "packageHash":scenario["packageHash"], "packetHash":scenario["packetHash"],
                            "depthSamples":4,"depth":depth,"vp":vp,"hdrNonBackground":nonclear,
                            "hdr":hdr,"normals":normals,"display":display,"lighting":lighting,
                            "shadowUniform":uniform,"shadowMapHash":hash::sha256(bytemuck::cast_slice(&snapshot.depths)),
                            "shadowMapNonClear":shadow_nonclear,"fullHash":hash::sha256(&snapshot.hdr),
                            "finalAttachment":"actual-production-OutputPass-from-scene-HDR"}));
                    }
                }
            }
            assert_eq!(frames.len(), 8);
            device.destroy();
            runs.push(json!({"freshInstance":fresh,"adapter":format!("{info:?}"),"frames":frames}));
        }
        let source = hdr_frame::shader_source();
        let evidence = json!({"family":"native","passed":true,"packageHash":input["packageHash"],
            "packetHash":input["packetHash"],"inputHash":hash::sha256(&bytes),"width":width,"height":height,
            "normalSpace":"world","gpuErrors":[],"sourceHash":hash::sha256(source.as_bytes()),"runs":runs});
        std::fs::write(
            std::env::var("J3_FULLSCENE_NATIVE_OUTPUT").expect("fresh output required"),
            serde_json::to_vec(&evidence).unwrap(),
        )
        .unwrap();
    });
}
