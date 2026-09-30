use crate::{
    c8_direct_multiscattering::hdr_frame,
    c8_geometry_roughness::fixture,
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    contract::validate_packet, player_view::PlayerView, scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
#[path = "../../src/shader_package/hash.rs"]
mod hash;

fn content(id: &str) -> (PlayerContent, Value) {
    let (mut content, mut packet) = fixture(true, id == "mapped");
    let material = &mut packet["materials"][0];
    if id != "lit-control" {
        material["shadingModel"] = json!("unlit");
    }
    material["baseColorTexture"] = json!({"texture":"base"});
    material["baseColorAlpha"] = json!(1.0);
    material["emissiveFactor"] = json!([16, 8, 4]);
    if id.starts_with("mask") {
        material["alphaMode"] = json!("MASK");
        material["alphaCutoff"] = json!(if id == "mask-accept" { 0.5 } else { 0.51 });
    }
    if id == "blend" {
        material["alphaMode"] = json!("BLEND");
    }
    packet["textures"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"base","revision":1,
        "width":1,"height":1,"semantic":"baseColor","data":[128,192,224,128],
        "sampler":{"magFilter":"nearest","minFilter":"nearest"}}));
    let authored = serde_json::from_value(packet.clone()).unwrap();
    validate_packet(&authored).unwrap();
    content.mutate_packet_for_test(|target| *target = authored);
    (content, packet)
}

#[test]
fn native_unlit_lighting_work_is_guarded_and_output_semantics_remain_outside() {
    for (source, entry, visibility) in [
        (
            include_str!("../../assets/shaders/native_mesh_v1.wgsl"),
            "fn shade_native_mesh(",
            "shadow_visibility(",
        ),
        (
            include_str!("../../assets/shaders/native_mesh_rt_fragment_v1.wgsl"),
            "@fragment fn fragment_main_rt(",
            "rt_directional_visibility(",
        ),
    ] {
        let body: String = source
            .split_once(entry)
            .unwrap()
            .1
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let marker = "if(!flag(input.material.w,64u)){";
        let start = body
            .find(marker)
            .expect("UNLIT must skip the complete lighting block");
        let inner = start + marker.len();
        let mut depth = 1;
        let end = inner
            + body[inner..]
                .char_indices()
                .find_map(|(i, c)| {
                    if c == '{' {
                        depth += 1;
                    } else if c == '}' {
                        depth -= 1;
                    }
                    (depth == 0).then_some(i)
                })
                .unwrap();
        let guarded = &body[inner..end];
        let outside = format!("{}{}", &body[..start], &body[end + 1..]);
        for call in [
            visibility,
            "brdfWithDielectricF0(",
            "native_direct_multiscattering(",
            "local_direct_lighting(",
            "textureSampleLevel(brdf_lut,",
            "textureSampleLevel(diffuse_environment,",
            "textureSampleLevel(specular_environment,",
        ] {
            assert!(guarded.contains(call), "lighting call not in guard: {call}");
            assert!(
                !outside.contains(call),
                "UNLIT still executes lighting: {call}"
            );
        }
        for semantic in [
            "native_view_geometry_roughness(geometry_normal)",
            "mapped_normal(input,front_facing)",
            "letauthored_light=",
            "letexposure=",
            "surface_color=mix(",
            "letoutput_alpha=",
        ] {
            assert!(
                outside.contains(semantic),
                "output/observation semantic incorrectly guarded: {semantic}"
            );
        }
    }
    for id in [
        "opaque",
        "mapped",
        "mask-accept",
        "mask-reject",
        "blend",
        "lit-control",
    ] {
        content(id);
    }
}

#[test]
#[ignore = "actual production UNLIT lighting independence and MASK/BLEND controls"]
fn c8_actual_native_unlit_lighting_skip() {
    pollster::block_on(async {
        let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/c8-native-unlit-lighting-skip");
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
            .expect("real hardware GPU");
        assert!(matches!(
            adapter.get_info().device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let mut rounds = Vec::new();
        for round in 0..2 {
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let mut cases = Vec::new();
            for id in [
                "opaque",
                "mapped",
                "mask-accept",
                "mask-reject",
                "blend",
                "lit-control",
            ] {
                let (content, packet) = content(id);
                let capture = id == "opaque" || id == "mapped";
                let mut hdr = Vec::new();
                let mut normal = Vec::new();
                let mut rows = Vec::new();
                for stress in [false, true] {
                    let configure = |frame: &mut deep_engine_native::mesh_abi::FrameUniform| {
                        let mut value = json!({"direction":[0,0,1],"radiance":if stress {[256,128,64]} else {[0,0,0]},
                            "exposure":1,"shadows":stress});
                        if stress {
                            value["localLights"] = json!([{"kind":"point","position":[0,0,4],"direction":[0,0,-1],
                            "radiance":[64,32,16],"range":20,"decay":2,"innerCos":1,"outerCos":0}]);
                        }
                        let light: DirectionalLighting = serde_json::from_value(value).unwrap();
                        light.validate().unwrap().apply(frame);
                        frame[9][3] = f32::from(stress);
                    };
                    let mut read = None;
                    let mut actual = Vec::new();
                    let snapshot = render_with_frame_observation(
                        &device,
                        &queue,
                        &content,
                        &mut FrameObservation {
                            size: PhysicalSize::new(128, 128),
                            view: PlayerView {
                                yaw: 0.0,
                                ..Default::default()
                            },
                            configure: Some(&configure),
                            capture_normals: capture,
                            shadow_options: None,
                            encode: &mut |device, encoder, targets, frame, _| {
                                actual = frame[9..19].to_vec();
                                if capture {
                                    let texture = targets
                                        .resolved_normal_texture()
                                        .expect("actual normal MRT");
                                    let buffer =
                                        crate::lod_draw_readback::staging(device, 128 * 128 * 4);
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
                                } else {
                                    assert!(targets.resolved_normal_texture().is_none());
                                }
                            },
                        },
                    )
                    .await;
                    assert!(hdr_frame::rgb(&snapshot.hdr).iter().all(|v| v.is_finite()));
                    if let Some(buffer) = read {
                        normal.push(crate::lod_draw_readback::mapped_bytes(&device, &buffer));
                    }
                    hdr.push(snapshot.hdr);
                    rows.push(actual);
                }
                let changed = hdr[0]
                    .chunks_exact(8)
                    .zip(hdr[1].chunks_exact(8))
                    .filter(|(a, b)| a != b)
                    .count();
                if id == "lit-control" {
                    assert!(
                        changed >= 1000,
                        "lighting fixture did not change real lit output"
                    );
                } else {
                    assert_eq!(changed, 0, "UNLIT changed with CSM/direct/local/IBL: {id}");
                }
                if capture {
                    assert_eq!(
                        normal[0], normal[1],
                        "lighting changed UNLIT normal/rough MRT"
                    );
                }
                let rgb = hdr_frame::rgb(&hdr[0]);
                let covered = (24..104)
                    .flat_map(|y| (24..104).map(move |x| y * 128 + x))
                    .filter(|p| rgb[p * 3..p * 3 + 3].iter().any(|v| *v > 0.05))
                    .count();
                if id == "mask-reject" {
                    assert_eq!(covered, 0, "MASK alpha cutoff was bypassed");
                } else {
                    assert!(covered >= 1000, "empty coverage case {id}");
                }
                cases.push(json!({"id":id,"changedLightingPixels":changed,"covered":covered,"actualFrameRows":rows,
                    "packetHash":hash::sha256(&serde_json::to_vec(&packet).unwrap()),
                    "hdrHashes":hdr.iter().map(|bytes|hash::sha256(bytes)).collect::<Vec<_>>(),
                    "normalHashes":normal.iter().map(|bytes|hash::sha256(bytes)).collect::<Vec<_>>()}));
            }
            device.destroy();
            rounds.push(cases);
        }
        assert_eq!(rounds[0], rounds[1]);
        std::fs::write(evidence,serde_json::to_vec_pretty(&json!({"passed":true,"freshDevices":2,
            "actualProductionFrames":24,"rounds":rounds,"sourceHash":hash::sha256(hdr_frame::shader_source().as_bytes()),
            "scope":"UNLIT full HDR lighting independence, opaque normal MRT and MASK/BLEND coverage",
            "excluded":["timed performance gain","RT actual frames","full Studio visuals"]})).unwrap()).unwrap();
    });
}
