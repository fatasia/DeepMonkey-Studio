use crate::j3_hdr_frame as hdr_frame;
use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::shader_package::hash;
use deep_engine_native::{
    player_view::PlayerView, runtime_package::parse_and_validate_runtime_package,
    scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;

const MANIFEST: &str = include_str!("../../../deep-engine/fixtures/j3-hdr-flat-normal-v1.json");
const PACKAGE: &[u8] = include_bytes!("../fixtures/runtime-package-v1.json");

fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
}

#[test]
#[ignore = "actual production optional normal MRT with unchanged HDR"]
fn j3_gate_d_actual_normal_attachments() {
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
        assert_eq!((width * 4) % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT, 0);
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
        let mut unique_points = 0;
        let configure = |frame: &mut deep_engine_native::mesh_abi::FrameUniform| {
            let lighting: DirectionalLighting = serde_json::from_value(json!({
                "direction": [-0.6, -0.3, 0.55_f32.sqrt()], "radiance": [2.5, 2.4, 2.25],
                "exposure": 1.0, "shadows": false
            }))
            .unwrap();
            lighting.validate().unwrap().apply(frame);
            frame[9][3] = 0.0;
        };
        for camera in manifest["cameras"].as_array().unwrap() {
            let view = PlayerView {
                focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan()) as f32,
                near: camera["near"].as_f64().unwrap() as f32,
                far: 40.0,
                ..Default::default()
            }
            .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
            .unwrap();
            let default = render_with_frame_observation(
                &device,
                &queue,
                &content,
                &mut FrameObservation {
                    size: PhysicalSize::new(width, height),
                    view,
                    configure: Some(&configure),
                    capture_normals: false,
                    shadow_options: None,
                    encode: &mut |_device, _encoder, targets, _frame, _shadows| {
                        assert!(
                            targets.resolved_normal_texture().is_none(),
                            "default path allocated a normal target"
                        );
                    },
                },
            )
            .await;
            let mut previous: Option<Vec<u8>> = None;
            for round in 0..2 {
                let mut normal_read = None;
                let mut vp = Vec::new();
                let snapshot = render_with_frame_observation(
                    &device,
                    &queue,
                    &content,
                    &mut FrameObservation {
                        size: PhysicalSize::new(width, height),
                        view,
                        configure: Some(&configure),
                        capture_normals: true,
                        shadow_options: None,
                        encode: &mut |device, encoder, targets, frame, _shadows| {
                            vp = frame[..4].iter().flatten().copied().collect();
                            let texture = targets
                                .resolved_normal_texture()
                                .expect("actual production normal target");
                            assert_eq!(texture.format(), wgpu::TextureFormat::Rgba8Unorm);
                            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                                label: Some("J3 actual normal readback"),
                                size: u64::from(width * height * 4),
                                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                                mapped_at_creation: false,
                            });
                            encoder.copy_texture_to_buffer(
                                wgpu::TexelCopyTextureInfo {
                                    texture,
                                    mip_level: 0,
                                    origin: wgpu::Origin3d::ZERO,
                                    aspect: wgpu::TextureAspect::All,
                                },
                                wgpu::TexelCopyBufferInfo {
                                    buffer: &buffer,
                                    layout: wgpu::TexelCopyBufferLayout {
                                        offset: 0,
                                        bytes_per_row: Some(width * 4),
                                        rows_per_image: Some(height),
                                    },
                                },
                                wgpu::Extent3d {
                                    width,
                                    height,
                                    depth_or_array_layers: 1,
                                },
                            );
                            normal_read = Some(buffer);
                        },
                    },
                )
                .await;
                assert_eq!(
                    snapshot.hdr, default.hdr,
                    "optional MRT changed production HDR bytes"
                );
                let normals =
                    crate::lod_draw_readback::mapped_bytes(&device, &normal_read.unwrap());
                if let Some(previous) = &previous {
                    assert_eq!(
                        normals, *previous,
                        "normal MRT changed on repeated production draw"
                    );
                }
                previous = Some(normals.clone());
                let hdr = hdr_frame::rgb(&snapshot.hdr);
                let mut samples = Vec::new();
                for subset in camera["subsets"].as_array().unwrap() {
                    let id = subset["instanceId"].as_str().unwrap();
                    let instance = packet["instances"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|i| i["id"] == id)
                        .unwrap();
                    let geometry = packet["geometries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|g| g["id"] == instance["geometry"])
                        .unwrap();
                    // Independent oracle for this preregistered axis-aligned flat profile.
                    // +Z normals under diagonal transforms with positive Z scale remain +Z,
                    // including the negative X determinant of the mirrored instance.
                    for vertex in geometry["vertices"].as_array().unwrap().chunks_exact(6) {
                        assert_eq!(
                            vector(&json!([vertex[3], vertex[4], vertex[5]])),
                            [0.0, 0.0, 1.0]
                        );
                    }
                    for offset in [1, 2, 4, 6, 8, 9] {
                        assert_eq!(instance["transform"][offset].as_f64().unwrap(), 0.0);
                    }
                    assert!(instance["transform"][10].as_f64().unwrap() > 0.0);
                    let material = packet["materials"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|m| m["id"] == subset["materialId"])
                        .unwrap();
                    assert!(material.get("normalTexture").is_none());
                    for pixel in subset["pixels"].as_array().unwrap() {
                        let pixel = pixel.as_u64().unwrap() as usize;
                        let encoded: Vec<f32> = normals[pixel * 4..pixel * 4 + 4]
                            .iter()
                            .map(|v| f32::from(*v) / 255.0)
                            .collect();
                        for (actual, expected) in encoded[..3].iter().zip([0.5, 0.5, 1.0]) {
                            assert!(
                                (actual - expected).abs() <= 1.0 / 255.0 + 1e-6,
                                "independent flat world normal mismatch"
                            );
                        }
                        assert!(
                            (encoded[3] - material["roughness"].as_f64().unwrap() as f32).abs()
                                <= 1.0 / 255.0 + 1e-6
                        );
                        samples.push(json!({"pixel":pixel,"instanceId":id,"encodedWorldNormal":encoded,"hdr":&hdr[pixel * 3..pixel * 3 + 3]}));
                    }
                }
                if round == 0 {
                    unique_points += samples.len();
                }
                frames.push(json!({"cameraId":camera["id"],"round":round,"actualVP":vp,"samples":samples,"defaultHdrUnchanged":true}));
            }
        }
        assert_eq!(unique_points, 85);
        let evidence = json!({"host":"native-production-mesh-pass","packageHash":manifest["packageHash"],"packetHash":packet_hash,
            "width":width,"height":height,"frames":frames,"normalAttachment":"production-world-normal-rgba8unorm",
            "normalAlpha":"perceptual-roughness","actualNormalAttachments":true,"gpuErrors":[],"adapter":format!("{info:?}"),
            "sourceHash":hash::sha256(hdr_frame::shader_source().as_bytes()),"excluded":["shadow matrix alignment","normal-map and smooth surfaces"]});
        let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/normal-shadow");
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(
            output.join("native.json"),
            serde_json::to_string(&evidence).unwrap(),
        )
        .unwrap();
    });
}
