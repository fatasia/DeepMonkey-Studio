use crate::j3_hdr_frame as hdr_frame;
use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::shader_package::hash;
use deep_engine_native::{
    cascaded_shadow::CascadedShadowOptions,
    contract::ShadingModel,
    fog::FogSettings,
    mesh_abi::{FRAME_FOG_PROJECTION_ROW, FrameUniform},
    player_view::PlayerView,
    runtime_package::parse_and_validate_runtime_package,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
const MANIFEST: &str = include_str!("../../../deep-engine/fixtures/j3-hdr-flat-normal-v1.json");
const PROFILE: &str = include_str!("../../../deep-engine/fixtures/j3-author-fog-v1.json");
const PACKAGE: &[u8] = include_bytes!("../fixtures/runtime-package-v1.json");
fn vector(v: &Value) -> [f32; 3] {
    std::array::from_fn(|i| v[i].as_f64().unwrap() as f32)
}
#[test]
#[ignore = "actual production authored exp2 HDR and material fog opt-out"]
fn j3_gate_d_actual_author_fog() {
    pollster::block_on(async {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let profile: Value = serde_json::from_str(PROFILE).unwrap();
        let package: Value = serde_json::from_slice(PACKAGE).unwrap();
        let packet = &package["payloads"][package["entrypoints"]["renderPacket"].as_str().unwrap()];
        let packet_hash = hash::sha256(&serde_json::to_vec(packet).unwrap());
        assert_eq!(packet_hash, manifest["packetHash"].as_str().unwrap());
        let loaded = parse_and_validate_runtime_package(PACKAGE).unwrap();
        assert_eq!(
            loaded.package_hash,
            manifest["packageHash"].as_str().unwrap()
        );
        let original = PlayerContent::from_package(loaded).unwrap();
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
            .unwrap();
        assert!(matches!(
            adapter.get_info().device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        let mut frames = vec![];
        for scenario in profile["scenarios"].as_array().unwrap() {
            let material_fog = scenario["materialFog"].as_bool().unwrap();
            let mut packet = original.packet().clone();
            for material in &mut packet.materials {
                material.shading_model = Some(ShadingModel::Unlit);
                material.fog = Some(material_fog);
            }
            let content = PlayerContent::from_packet(packet, None);
            let fog = FogSettings::authored_exp2(
                scenario["density"].as_f64().unwrap() as f32,
                vector(&profile["color"]),
            )
            .unwrap();
            for camera in manifest["cameras"].as_array().unwrap() {
                let view = PlayerView {
                    focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan())
                        as f32,
                    near: camera["near"].as_f64().unwrap() as f32,
                    far: camera["far"].as_f64().unwrap() as f32,
                    ..Default::default()
                }
                .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
                .unwrap();
                let configure = |frame: &mut FrameUniform| {
                    hdr_frame::configure(&manifest, frame);
                    frame[12] = fog.frame_tuning();
                    frame[FRAME_FOG_PROJECTION_ROW] = fog.frame_projection(view.near, view.far);
                };
                for round in 0..2 {
                    let mut vp = vec![];
                    let snapshot = render_with_frame_observation(
                        &device,
                        &queue,
                        &content,
                        &mut FrameObservation {
                            capture_normals: false,
                            shadow_options: Some(CascadedShadowOptions {
                                cascade_count: 2,
                                shadow_map_size: 64,
                                max_shadow_distance: 40.,
                                split_lambda: 0.7,
                                depth_padding: 10.,
                                blend_ratio: 0.,
                            }),
                            size: PhysicalSize::new(width, height),
                            view,
                            configure: Some(&configure),
                            encode: &mut |_device, _encoder, _targets, frame, _shadows| {
                                vp = frame[..4].iter().flatten().copied().collect::<Vec<_>>();
                            },
                        },
                    )
                    .await;
                    let rgb = hdr_frame::rgb(&snapshot.hdr);
                    let samples=camera["subsets"].as_array().unwrap().iter().flat_map(|subset|{
                        subset["pixels"].as_array().unwrap().iter().map(|p| {
                            let pixel=p.as_u64().unwrap() as usize;
                            json!({"pixel":pixel,"instanceId":subset["instanceId"],"hdr":[rgb[pixel*3],rgb[pixel*3+1],rgb[pixel*3+2],
                                deep_engine_native::half_decode::half_to_f32(u16::from_le_bytes([snapshot.hdr[pixel*8+6],snapshot.hdr[pixel*8+7]]))]})
                        })
                    }).collect::<Vec<_>>();
                    let lanes = snapshot
                        .hdr
                        .chunks_exact(2)
                        .map(|p| u16::from_le_bytes([p[0], p[1]]).to_string())
                        .collect::<Vec<_>>()
                        .join(",");
                    frames.push(json!({"cameraId":camera["id"],"scenario":scenario["id"],"round":round,"samples":samples,
                        "rgbaHash":hash::sha256(lanes.as_bytes()),"vp":vp}));
                }
            }
        }
        let opt_out_unchanged = frames
            .iter()
            .filter(|f| f["scenario"] == "material-opt-out")
            .all(|f| {
                let control = frames
                    .iter()
                    .find(|c| {
                        c["cameraId"] == f["cameraId"]
                            && c["round"] == f["round"]
                            && c["scenario"] == "control"
                    })
                    .unwrap();
                control["rgbaHash"] == f["rgbaHash"]
            });
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/author-fog");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("native.json"),serde_json::to_vec_pretty(&json!({"passed":opt_out_unchanged,
            "packageHash":manifest["packageHash"],"packetHash":packet_hash,"profileHash":hash::sha256(PROFILE.as_bytes()),
            "width":width,"height":height,"sourceHash":hash::sha256(hdr_frame::shader_source().as_bytes()),
            "frames":frames,"materialOptOutUnchanged":opt_out_unchanged,"errors":[]})).unwrap()).unwrap();
        assert!(
            opt_out_unchanged,
            "Native authored exp2 ignored material.fog=false: full HDR differs from control; see author-fog/native.json"
        );
    });
}
