use crate::{
    c8_direct_multiscattering::{PACKAGE, hdr_frame},
    c8_geometry_basis::{analytic_normal, derivative_interval},
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    contract::validate_packet, player_view::PlayerView,
    runtime_package::parse_and_validate_runtime_package, scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
#[path = "../../src/shader_package/hash.rs"]
mod hash;

pub(super) fn fixture(smooth: bool, mapped: bool) -> (PlayerContent, Value) {
    let mut vertices = Vec::new();
    let mut tangents = Vec::new();
    for [x, y] in [[-1.4_f32, -1.4], [1.4, -1.4], [1.4, 1.4], [-1.4, 1.4]] {
        let raw = if smooth {
            [0.8 * x, 0.8 * y, 1.0]
        } else {
            [0.0, 0.0, 1.0]
        };
        let length = raw.into_iter().map(|v| v * v).sum::<f32>().sqrt();
        vertices.extend([x, y, 0.0]);
        let normal = raw.map(|v| v / length);
        vertices.extend(normal);
        let tangent = [
            1.0 - normal[0] * normal[0],
            -normal[1] * normal[0],
            -normal[2] * normal[0],
        ];
        let tangent_length = tangent.into_iter().map(|v| v * v).sum::<f32>().sqrt();
        tangents.extend(tangent.map(|v| v / tangent_length));
        tangents.push(1.0);
    }
    let mut material =
        json!({"id":"material","baseColor":[0.25,0.35,0.45],"metallic":0.4,"roughness":0.08});
    if mapped {
        material["normalTexture"] = json!({"texture":"normal","normalScale":1.0});
    }
    let packet = json!({"schema":"deep-engine.render-packet","version":1,
        "geometries":[{"id":"smooth-plane","revision":1,"vertices":vertices,"indices":[0,1,2,0,2,3],
            "uv0":[0,0,1,0,1,1,0,1],"tangents":tangents}],
        "materials":[material],"instances":[{"id":"surface","geometry":"smooth-plane","material":"material",
            "castShadow":false,"receiveShadow":false,"transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],
        "textures":if mapped {json!([{"id":"normal","revision":1,"width":1,"height":1,
            "semantic":"normal","data":[210,128,220,255],"sampler":{"magFilter":"nearest","minFilter":"nearest"}}])} else {json!([])}
    });
    let mut content =
        PlayerContent::from_package(parse_and_validate_runtime_package(PACKAGE).unwrap()).unwrap();
    let authored = serde_json::from_value(packet.clone()).unwrap();
    validate_packet(&authored).unwrap();
    content.mutate_packet_for_test(|target| *target = authored);
    (content, packet)
}

#[test]
fn native_geometry_fixture_preserves_unperturbed_smooth_normals() {
    let (plain, _) = fixture(true, false);
    let (mapped, _) = fixture(true, true);
    assert_eq!(
        plain.packet().geometries[0].vertices,
        mapped.packet().geometries[0].vertices
    );
    assert!(plain.packet().materials[0].normal_texture.is_none());
    assert!(mapped.packet().materials[0].normal_texture.is_some());
    assert_eq!(plain.packet().materials[0].roughness, 0.08);
    let interval = derivative_interval(
        64,
        64,
        f64::from(deep_engine_native::mesh_abi::CAMERA_FOCAL),
    );
    assert!(interval[0] > 1.0 / 255.0 && interval[1] < 0.1);
}

#[test]
#[ignore = "actual production geometry roughness MRT, two fresh hardware devices"]
fn c8_actual_native_geometry_roughness() {
    pollster::block_on(async {
        let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/c8-native-geometry-roughness");
        std::fs::create_dir_all(&output).unwrap();
        let evidence = output.join("evidence.json");
        if evidence.exists() {
            std::fs::remove_file(&evidence).unwrap();
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("actual hardware GPU");
        let info = adapter.get_info();
        assert!(matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let view = PlayerView {
            yaw: 0.0,
            pitch: 0.0,
            ..Default::default()
        };
        let configure = |frame: &mut deep_engine_native::mesh_abi::FrameUniform| {
            let light: DirectionalLighting = serde_json::from_value(json!({
                "direction":[0,0,1],"radiance":[2.5,2.4,2.25],"exposure":1,"shadows":false
            }))
            .unwrap();
            light.validate().unwrap().apply(frame);
            frame[9][3] = 0.0;
        };
        let mut rounds = Vec::new();
        let mut previous: Option<Vec<Vec<u8>>> = None;
        for round in 0..2 {
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let mut frames = Vec::new();
            let mut attachments = Vec::new();
            for (id, smooth, mapped) in [
                ("smooth", true, false),
                ("flat", false, false),
                ("mapped", true, true),
            ] {
                let (content, packet) = fixture(smooth, mapped);
                let default = render_with_frame_observation(
                    &device,
                    &queue,
                    &content,
                    &mut FrameObservation {
                        size: PhysicalSize::new(128, 128),
                        view,
                        configure: Some(&configure),
                        capture_normals: false,
                        shadow_options: None,
                        encode: &mut |_, _, targets, _, _| {
                            assert!(targets.resolved_normal_texture().is_none())
                        },
                    },
                )
                .await;
                let mut read = None;
                let mut actual_vp = Vec::new();
                let captured = render_with_frame_observation(
                    &device,
                    &queue,
                    &content,
                    &mut FrameObservation {
                        size: PhysicalSize::new(128, 128),
                        view,
                        configure: Some(&configure),
                        capture_normals: true,
                        shadow_options: None,
                        encode: &mut |device, encoder, targets, frame, _| {
                            actual_vp = frame[..4].iter().flatten().copied().collect();
                            let texture = targets
                                .resolved_normal_texture()
                                .expect("production normal MRT");
                            assert_eq!(texture.format(), wgpu::TextureFormat::Rgba8Unorm);
                            let buffer = crate::lod_draw_readback::staging(device, 128 * 128 * 4);
                            encoder.copy_texture_to_buffer(
                                texture.as_image_copy(),
                                wgpu::TexelCopyBufferInfo {
                                    buffer: &buffer,
                                    layout: wgpu::TexelCopyBufferLayout {
                                        offset: 0,
                                        bytes_per_row: Some(512),
                                        rows_per_image: Some(128),
                                    },
                                },
                                texture.size(),
                            );
                            read = Some(buffer);
                        },
                    },
                )
                .await;
                assert_eq!(
                    captured.hdr, default.hdr,
                    "normal capture changed actual HDR"
                );
                let hdr = hdr_frame::rgb(&captured.hdr);
                assert!(hdr.iter().all(|v| v.is_finite()));
                let normal = crate::lod_draw_readback::mapped_bytes(&device, &read.unwrap());
                assert_eq!(normal.len(), 128 * 128 * 4);
                let mut positive = 0;
                let mut hdr_coverage = 0;
                let mut max_interval_error = 0.0_f64;
                for y in 24..104 {
                    for x in 24..104 {
                        let pixel = y * 128 + x;
                        if hdr[pixel * 3..pixel * 3 + 3].iter().any(|v| *v > 0.03) {
                            hdr_coverage += 1;
                        }
                        let alpha = f64::from(normal[pixel * 4 + 3]) / 255.0;
                        let bounds = if smooth {
                            derivative_interval(x, y, f64::from(view.focal))
                        } else {
                            [0.0, 0.0]
                        };
                        let error = (0.08 + bounds[0] - alpha)
                            .max(alpha - 0.08 - bounds[1])
                            .max(0.0);
                        max_interval_error = max_interval_error.max(error);
                        assert!(
                            error <= if smooth { 2.0 / 255.0 } else { 1.0 / 255.0 },
                            "rough interval round={round} {id} {x},{y}: {alpha} bounds={bounds:?}"
                        );
                        if alpha > 0.08 + 1.0 / 255.0 {
                            positive += 1;
                        }
                        if !mapped {
                            let expected = if smooth {
                                analytic_normal(x, y, f64::from(view.focal))
                            } else {
                                [0.0, 0.0, 1.0]
                            };
                            for lane in 0..3 {
                                let actual = f64::from(normal[pixel * 4 + lane]) / 255.0;
                                assert!(
                                    (actual - (expected[lane] * 0.5 + 0.5)).abs() <= 1.0 / 255.0,
                                    "world normal oracle"
                                );
                            }
                        }
                    }
                }
                if smooth {
                    assert!(positive >= 1000);
                } else {
                    assert_eq!(positive, 0);
                }
                assert!(hdr_coverage >= 1000, "empty production first frame");
                frames.push(
                    json!({"case":id,"interior":6400,"positiveRoughnessPixels":positive,"hdrCoverage":hdr_coverage,
                    "maxIntervalError":max_interval_error,"actualVP":actual_vp,
                    "packetHash":hash::sha256(&serde_json::to_vec(&packet).unwrap()),
                    "normalHash":hash::sha256(&normal),"hdrHash":hash::sha256(&captured.hdr)}),
                );
                attachments.push(normal);
            }
            let mut changed = 0;
            for y in 24..104 {
                for x in 24..104 {
                    let p = (y * 128 + x) * 4;
                    assert_eq!(
                        attachments[0][p + 3],
                        attachments[2][p + 3],
                        "mapped normal leaked into geometryrough"
                    );
                    if attachments[0][p..p + 3] != attachments[2][p..p + 3] {
                        changed += 1;
                    }
                }
            }
            assert!(changed >= 1000, "normal map was not actually consumed");
            if let Some(previous) = &previous {
                assert_eq!(&attachments, previous, "fresh devices differ");
            }
            previous = Some(attachments);
            device.destroy();
            rounds.push(json!({"round":round,"frames":frames,"mappedNormalChangedPixels":changed}));
        }
        assert_eq!(rounds[0]["frames"], rounds[1]["frames"]);
        std::fs::write(evidence,serde_json::to_string_pretty(&json!({
            "passed":true,"freshDevices":2,"actualProductionFrames":12,"rounds":rounds,
            "sourceHash":hash::sha256(hdr_frame::shader_source().as_bytes()),
            "originPackageHash":hash::sha256(PACKAGE),"adapter":format!("{info:?}"),
            "normalAttachment":"rgba8unorm-world-normal-effective-roughness",
            "budget":2.0/255.0,"excluded":["RT hardware","cross-backend derivatives","Studio visual quality"]
        })).unwrap()).unwrap();
    });
}
