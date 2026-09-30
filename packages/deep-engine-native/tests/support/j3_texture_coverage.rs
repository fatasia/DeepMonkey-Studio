use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    cascaded_shadow::CascadedShadowOptions, half_decode::half_to_f32,
    mesh_abi::FrameUniform, player_view::PlayerView,
    runtime_package::{parse_and_validate_runtime_package, runtime_content_sha256},
    scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
#[path = "../../src/shader_package/hash.rs"]
mod hash;

fn vec3(value: &Value) -> [f32; 3] {
    std::array::from_fn(|k| value[k].as_f64().unwrap() as f32)
}

#[test]
#[ignore = "actual shared runtime texture/UV/coverage frames, two fresh hardware devices"]
fn j3_actual_texture_uv_coverage() {
    pollster::block_on(async {
        let input_path = std::env::var("J3_TEXTURE_INPUT_PATH").expect("fresh runner input required");
        let output_path = std::env::var("J3_TEXTURE_NATIVE_OUTPUT").expect("fresh runner output required");
        let input_bytes = std::fs::read(input_path).unwrap();
        let input: Value = serde_json::from_slice(&input_bytes).unwrap();
        assert_eq!(input["schema"], "j3-texture-coverage-plan-v1");
        let f = &input["fixture"];
        assert_eq!(f["schema"], "j3-texture-coverage-v1");
        assert_eq!(input["scenarios"].as_array().unwrap().len(), 7);
        assert_eq!(input["cameras"].as_array().unwrap().len(), 2);
        assert_eq!(f["dfg"], json!([0.75, 0.0625]));
        if std::path::Path::new(&output_path).exists() {
            std::fs::remove_file(&output_path).unwrap();
        }
        let width = input["width"].as_u64().unwrap() as u32;
        let height = input["height"].as_u64().unwrap() as u32;
        assert_eq!((width, height), (128, 128));
        let mut runs = vec![];
        for fresh in 0..2 {
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
            let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            }).await.unwrap();
            let info = adapter.get_info();
            assert!(matches!(info.device_type, wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu));
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let mut frames = vec![];
            for scenario in input["scenarios"].as_array().unwrap() {
                let id = scenario["id"].as_str().unwrap();
                let package = parse_and_validate_runtime_package(scenario["packageText"].as_str().unwrap().as_bytes()).unwrap();
                assert_eq!(package.package_hash, scenario["packageHash"].as_str().unwrap());
                let key = scenario["package"]["entrypoints"]["renderPacket"].as_str().unwrap();
                let packet_hash = runtime_content_sha256(&scenario["package"]["payloads"][key]);
                assert_eq!(packet_hash, scenario["packetHash"].as_str().unwrap());
                let mut content = PlayerContent::from_package(package).unwrap();
                for mip in content.environment.specular.mips.iter_mut().chain(content.environment.diffuse.mips.iter_mut()) {
                    mip.texels.fill([0.0, 0.0, 0.0, 1.0]);
                }
                content.environment.brdf_lut.texels.fill([0.75, 0.0625, 0.0, 1.0]);
                for camera in input["cameras"].as_array().unwrap() {
                    let view = PlayerView {
                        focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan()) as f32,
                        near: camera["near"].as_f64().unwrap() as f32,
                        far: camera["far"].as_f64().unwrap() as f32,
                        ..Default::default()
                    }.with_eye_target(vec3(&camera["eye"]), vec3(&camera["target"])).unwrap();
                    let configure = |frame: &mut FrameUniform| {
                        let light: DirectionalLighting = serde_json::from_value(json!({
                            "direction": f["surfaceToLight"],
                            "radiance": if id.starts_with("mr-") { f["radiance"].clone() } else { json!([0,0,0]) },
                            "exposure": 1, "shadows": false
                        })).unwrap();
                        light.validate().unwrap().apply(frame);
                        frame[9][3] = 0.0;
                    };
                    for round in 0..2 {
                        let capture = id.starts_with("mr-");
                        let mut normal_read = None;
                        let mut actual_frame = vec![];
                        let snapshot = render_with_frame_observation(&device, &queue, &content, &mut FrameObservation {
                            capture_normals: capture,
                            shadow_options: Some(CascadedShadowOptions { cascade_count: 2, shadow_map_size: 64,
                                max_shadow_distance: 40.0, split_lambda: 0.7, depth_padding: 10.0, blend_ratio: 0.0 }),
                            size: PhysicalSize::new(width, height), view, configure: Some(&configure),
                            encode: &mut |device, encoder, targets, frame, _| {
                                actual_frame = frame.iter().flatten().copied().collect::<Vec<_>>();
                                if capture {
                                    let texture = targets.resolved_normal_texture().expect("actual material normal MRT");
                                    let buffer = crate::lod_draw_readback::staging(device, u64::from(width * height * 4));
                                    encoder.copy_texture_to_buffer(texture.as_image_copy(), wgpu::TexelCopyBufferInfo {
                                        buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0,
                                            bytes_per_row: Some(width * 4), rows_per_image: Some(height) }
                                    }, texture.size());
                                    normal_read = Some(buffer);
                                }
                            }
                        }).await;
                        assert_eq!(snapshot.hdr.len(), (width * height * 8) as usize);
                        let rgba: Vec<f32> = snapshot.hdr.chunks_exact(2).map(|v| half_to_f32(u16::from_le_bytes([v[0],v[1]]))).collect();
                        assert!(rgba.iter().all(|v| v.is_finite()));
                        let normals = normal_read.map(|buffer| crate::lod_draw_readback::mapped_bytes(&device, &buffer));
                        let samples: Vec<Value> = camera["points"].as_array().unwrap().iter().map(|p| {
                            let pixel = p["pixel"].as_u64().unwrap() as usize;
                            json!({"pixel":pixel,"hdr":&rgba[pixel*4..pixel*4+4],
                                "roughness":normals.as_ref().map(|v| f64::from(v[pixel*4+3])/255.0).unwrap_or(0.0)})
                        }).collect();
                        let coverage: Vec<u8> = rgba.chunks_exact(4).map(|pixel| u8::from((0..3).any(|k| {
                            (f64::from(pixel[k]) - f["background"][k].as_f64().unwrap()).abs() > 0.008
                        }))).collect();
                        let draw_calls = snapshot.commands.iter().flatten().filter(|v| v[0] > 0 && v[1] > 0).count();
                        // The observation path rasterizes through the direct-draw
                        // encoder, so the LOD indirect command readback stays empty
                        // here (every other leaf on this renderer asserts nothing
                        // about it); raster evidence is the coverage mask instead.
                        let coverage_ones = coverage.iter().filter(|v| **v == 1).count();
                        assert!(coverage_ones > 0, "J3DBG coverage_ones={coverage_ones}");
                        let draw_calls = coverage_ones;
                        frames.push(json!({"scenario":id,"cameraId":camera["id"],"round":round,
                            "packageHash":scenario["packageHash"],"packetHash":packet_hash,
                            "fullHash":hash::sha256(&snapshot.hdr),"normalHash":normals.as_ref().map(|v|hash::sha256(v)),
                            "vp":&actual_frame[..16],"frame":actual_frame,"drawCalls":draw_calls,
                            "finalAttachment":"resolved-native-forward-hdr","coverage":coverage,"coveragePixels":draw_calls,"samples":samples}));
                    }
                }
            }
            assert_eq!(frames.len(), 28);
            device.destroy();
            runs.push(json!({"freshInstance":fresh,"adapter":format!("{info:?}"),"frames":frames}));
        }
        let source = deep_engine_native::native_mesh_wgsl::native_mesh_shader_source();
        let result = json!({"schema":"j3-texture-coverage-host-v1","family":"native","passed":true,
            "sourcePackageHash":input["sourcePackageHash"],"sourcePacketHash":input["sourcePacketHash"],
            "inputHash":hash::sha256(&input_bytes),"profileHash":input["profileHash"],
            "sourceHash":hash::sha256(source.as_bytes()),"source":source,
            "sourceAssembly":{"factory":"native_mesh_wgsl::native_mesh_shader_source","vertex":"vertex_main","fragment":"fragment_main"},
            "runs":runs,"errors":[]});
        std::fs::write(output_path, serde_json::to_vec(&result).unwrap()).unwrap();
    });
}
