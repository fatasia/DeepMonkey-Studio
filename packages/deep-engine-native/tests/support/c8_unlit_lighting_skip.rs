use crate::{
    c8_direct_multiscattering::hdr_frame,
    c8_geometry_roughness::fixture,
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::shader_package::hash;
use deep_engine_native::{
    contract::validate_packet, player_view::PlayerView, scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;

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
    // I-C23 起守卫形态变更(历史遗留修复):UNLIT 早退改为 native_lit_response
    // 顶部的 `if (flag(64u)) { return base; }`,完整光照体在其后——UNLIT 命中
    // 早退即跳过全部光照工作。因此守卫断言从"倒置块包含光照调用"改为:
    // ① 早退必须仍在响应核顶部;② 全部光照调用首现于早退之后;
    // ③ 光照文本不逃出共享响应核(RT 变体只消费 native_lit_response)。
    // rt_directional_visibility 是 RT 专属阴影机制,位于响应核之前,不在本断言族。
    let mesh = include_str!("../../assets/shaders/native_mesh_v1.wgsl");
    let rt = include_str!("../../assets/shaders/native_mesh_rt_fragment_v1.wgsl");
    let response_body: String = mesh
        .split_once("fn native_lit_response(")
        .expect("shared response core must exist")
        .1
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let marker = "if(flag(input.material.w,64u)){returnbase;}";
    let guard_end = response_body
        .find(marker)
        .expect("UNLIT early-return must stay at the top of native_lit_response")
        + marker.len();
    for call in [
        "shadow_visibility(",
        "brdfWithDielectricF0(",
        "native_direct_multiscattering(",
        "local_direct_lighting(",
        "textureSampleLevel(brdf_lut,",
        "textureSampleLevel(diffuse_environment,",
        "textureSampleLevel(specular_environment,",
    ] {
        let first = response_body
            .find(call)
            .unwrap_or_else(|| panic!("lighting call missing from the response core: {call}"));
        assert!(
            first > guard_end,
            "lighting call before the UNLIT early-return: {call}"
        );
        assert!(
            !rt.contains(call),
            "RT fragment must consume the shared response core, not a text copy: {call}"
        );
    }
    assert!(mesh.contains("let original = native_lit_response("));
    assert!(mesh.contains("if (legacy) {\n    return original;"));
    let stripped_mesh: String = mesh.chars().filter(|c| !c.is_whitespace()).collect();
    for semantic in [
        "native_view_geometry_roughness(geometry_normal)",
        "mapped_normal(input,front_facing)",
        "letauthored_light=",
        "surface_color=native_extended_shade(",
        "letoutput_alpha=",
    ] {
        assert!(
            stripped_mesh.contains(semantic),
            "output/observation semantic incorrectly guarded: {semantic}"
        );
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
        for _round in 0..2 {
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
