use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::shader_package::hash;
use deep_engine_native::{
    cascaded_shadow::CascadedShadowOptions,
    fog::FogSettings,
    half_decode::half_to_f32,
    mesh_abi::{FRAME_FOG_PROFILE_ROW, FRAME_FOG_PROJECTION_ROW},
    player_view::PlayerView,
    runtime_package::parse_and_validate_runtime_package,
    scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use std::io::Write;
use winit::dpi::PhysicalSize;
#[path = "j3_industrial_effects_readback.rs"]
mod readback;
fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
}
fn rgba(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|v| half_to_f32(u16::from_le_bytes([v[0], v[1]])))
        .collect()
}
#[test]
#[ignore = "actual same industrial live HDR and legal production Fog/Bloom, two hardware devices"]
fn j3_gate_d_actual_industrial_effects() {
    pollster::block_on(async {
        let bytes = std::fs::read(std::env::var("J3_INDUSTRIAL_SCENE_INPUT").unwrap()).unwrap();
        let scene: Value = serde_json::from_slice(&bytes).unwrap();
        let profile_bytes =
            std::fs::read(std::env::var("J3_INDUSTRIAL_EFFECTS_PROFILE").unwrap()).unwrap();
        let effects: Value = serde_json::from_slice(&profile_bytes).unwrap();
        let output_path =
            std::path::PathBuf::from(std::env::var("J3_INDUSTRIAL_EFFECTS_OUTPUT").unwrap());
        let sidecar_dir = output_path.parent().unwrap().join("native-frames");
        std::fs::create_dir_all(&sidecar_dir).unwrap();
        assert_eq!(effects["schema"], "j3-industrial-effects-plan-v1");
        assert_eq!(effects["sceneInputHash"], hash::sha256(&bytes));
        let size = PhysicalSize::new(512, 512);
        assert_eq!(
            (scene["width"].as_u64(), scene["height"].as_u64()),
            (Some(512), Some(512))
        );
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
            let package = parse_and_validate_runtime_package(
                scene["packageText"].as_str().unwrap().as_bytes(),
            )
            .unwrap();
            assert_eq!(package.package_hash, scene["packageHash"].as_str().unwrap());
            let content = PlayerContent::from_package(package).unwrap();
            let mut frames = vec![];
            for camera in scene["cameras"].as_array().unwrap() {
                let view = PlayerView {
                    focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan())
                        as f32,
                    near: 0.1,
                    far: 40.0,
                    ..Default::default()
                }
                .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
                .unwrap();
                for profile in effects["cases"].as_array().unwrap() {
                    let id = profile.as_str().unwrap();
                    let f = &scene["profile"];
                    let fog = &effects["native"]["fog"];
                    let volume = id.contains("volume");
                    let configure = |frame: &mut deep_engine_native::mesh_abi::FrameUniform| {
                        let lighting: DirectionalLighting =
                            serde_json::from_value(json!({ "direction": f["surfaceToLight"],
                            "radiance": f["radiance"], "exposure": 1, "shadows": true }))
                            .unwrap();
                        lighting.validate().unwrap().apply(frame);
                        frame[9][3] = 0.0;
                        if volume {
                            let settings = FogSettings::volumetric_with_profile(
                                fog["density"].as_f64().unwrap() as f32,
                                vector(&fog["color"]),
                                fog["steps"].as_u64().unwrap() as u32,
                                fog["height"].as_f64().unwrap() as f32,
                                fog["anisotropy"].as_f64().unwrap() as f32,
                            )
                            .unwrap();
                            frame[12] = settings.frame_tuning();
                            frame[FRAME_FOG_PROJECTION_ROW] =
                                settings.frame_projection(view.near, view.far);
                            frame[FRAME_FOG_PROFILE_ROW] = settings.frame_profile();
                        }
                    };
                    for round in 0..2 {
                        let mut captured = None;
                        let mut actual_frame = vec![];
                        let snapshot = render_with_frame_observation(
                            &device,
                            &queue,
                            &content,
                            &mut FrameObservation {
                                capture_normals: false,
                                size,
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
                                encode: &mut |device, encoder, targets, frame, _shadows| {
                                    actual_frame = frame.to_vec();
                                    captured = Some(readback::encode(
                                        device, encoder, targets, frame, id, size,
                                    ));
                                },
                            },
                        )
                        .await;
                        let captured = captured.unwrap();
                        let depth_bytes =
                            crate::lod_draw_readback::mapped_bytes(&device, &captured.depth);
                        let depth: Vec<f32> = bytemuck::cast_slice::<u8, f32>(&depth_bytes)
                            .chunks_exact(4)
                            .map(|samples| samples.iter().copied().fold(1.0, f32::min))
                            .collect();
                        let display =
                            crate::lod_draw_readback::mapped_bytes(&device, &captured.display);
                        let blurred = captured.blurred.map(|buffer| {
                            rgba(&crate::lod_draw_readback::mapped_bytes(&device, &buffer))
                        });
                        let actual = json!({ "cameraId": camera["id"], "profile": id, "round": round, "source": rgba(&snapshot.hdr),
                            "depth": depth, "frame": actual_frame, "display": display, "blurred": blurred,
                            "sourceRawHash": hash::sha256(&snapshot.hdr), "displayRawHash": hash::sha256(&display),
                            "finalAttachment": "actual-production-Native-BloomPass-and-OutputPass-from-live-industrial-HDR" });
                        let filename = format!("fresh-{fresh}-frame-{:03}.json", frames.len());
                        let path = sidecar_dir.join(&filename);
                        let file = std::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&path)
                            .unwrap();
                        let mut writer = std::io::BufWriter::new(file);
                        serde_json::to_writer(&mut writer, &actual).unwrap();
                        writer.flush().unwrap();
                        let attachment_hash = hash::sha256(&std::fs::read(&path).unwrap());
                        frames.push(
                            json!({ "cameraId": camera["id"], "profile": id, "round": round,
                            "attachment": filename, "attachmentSha256": attachment_hash }),
                        );
                    }
                }
            }
            assert_eq!(frames.len(), 16);
            device.destroy();
            runs.push(
                json!({ "freshInstance": fresh, "adapter": format!("{info:?}"), "frames": frames }),
            );
        }
        std::fs::write(output_path, serde_json::to_vec(&json!({ "passed": true,
            "family": "native", "packageHash": scene["packageHash"], "packetHash": scene["packetHash"], "width": 512, "height": 512,
            "sceneInputHash": hash::sha256(&bytes), "effectsInputHash": hash::sha256(&profile_bytes), "runs": runs })).unwrap()).unwrap();
    });
}
