use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    cascaded_shadow::CascadedShadowOptions, mesh_abi::FrameUniform, player_view::PlayerView,
    probe_gi_abi::IrradianceProbeRecord, probe_gi_grid::ProbeGiGridHeader,
    runtime_package::parse_and_validate_runtime_package,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
#[path = "../../src/shader_package/hash.rs"]
mod hash;
#[path = "j3_hdr_frame.rs"]
mod hdr;
const MANIFEST: &str = include_str!("../../../deep-engine/fixtures/j3-hdr-flat-normal-v1.json");
const FIXTURE: &str = include_str!("../../../deep-engine/fixtures/j2-probe-gi-aniso-v1.json");
const PACKAGE: &[u8] = include_bytes!("../fixtures/runtime-package-v1.json");
fn vec3(v: &Value) -> [f32; 3] {
    std::array::from_fn(|k| v[k].as_f64().unwrap() as f32)
}
/// Frozen independent copy of the per-cell profiles (a fixture edit must break
/// identity rather than silently follow; mirrors scripts/lib/j2ProbeAnisoIdentity.mjs).
fn cell_irradiance(linear: usize, scenario: &str) -> [f32; 3] {
    let cell = [linear % 3, (linear / 3) % 3, linear / 9];
    match scenario {
        "zero" => [0.0, 0.0, 0.0],
        "z-ramp" => [[0.25, 0.5, 1.0], [0.5, 1.0, 2.0], [1.0, 2.0, 4.0]][cell[2]],
        _ => {
            if (cell[0] + cell[1] + cell[2]) % 2 == 0 {
                [0.25, 0.5, 1.0]
            } else {
                [1.0, 2.0, 4.0]
            }
        }
    }
}
fn records(f: &Value, scenario: &str) -> Vec<IrradianceProbeRecord> {
    let header = ProbeGiGridHeader {
        origin: vec3(&f["origin"]),
        spacing: f["spacing"].as_f64().unwrap() as f32,
        grid_size: [3; 3],
        probe_count: 27,
    };
    let mut records = vec![header.encode().unwrap()];
    records.extend((0..27).map(|probe| {
        let rgb = cell_irradiance(probe, scenario);
        IrradianceProbeRecord {
            irradiance: rgb,
            validity: 1.0,
            mean_distance: 100000.0,
            distance_variance: 1.0,
            occlusion_floor: 0.0,
            padding: 0.0,
            position_offset: [0.0; 3],
            position_padding: 0.0,
            reserved: [0.0; 12],
        }
    }));
    records
}
#[derive(serde::Deserialize)]
struct PlanPoint {
    pixel: usize,
    base: [f32; 3],
    world: [f32; 3],
    normal: [f32; 3],
}
#[derive(serde::Deserialize)]
struct PlanCamera {
    id: String,
    points: Vec<PlanPoint>,
}
#[test]
#[ignore = "actual canonical aniso storage probe GI nonmetal HDR, original85points"]
fn j2_b5_aniso_probe_gi() {
    pollster::block_on(async {
        let m: Value = serde_json::from_str(MANIFEST).unwrap();
        let f: Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(f["normalBiasCells"], 0.2);
        assert_eq!(f["metallic"], 0);
        // Per-point expectations come from the runner's frozen CPU plan (world +
        // normal geometry admission); the formal CPU sampler reproduces the
        // native storage oracle expectation independently per point.
        let plan_path = std::env::var("J2_ANISO_PLAN_PATH")
            .expect("J2_ANISO_PLAN_PATH must point at the runner cpu-plan.json");
        let plan_text = std::fs::read_to_string(&plan_path).unwrap();
        let plan: Value = serde_json::from_str(&plan_text).unwrap();
        let points: Vec<PlanCamera> = serde_json::from_value(plan["cameras"].clone()).unwrap();
        assert_eq!(points.iter().map(|c| c.points.len()).sum::<usize>(), 85);
        let loaded = parse_and_validate_runtime_package(PACKAGE).unwrap();
        assert_eq!(loaded.package_hash, m["packageHash"].as_str().unwrap());
        let _original = PlayerContent::from_package(loaded).unwrap();
        let package_json: Value = serde_json::from_slice(PACKAGE).unwrap();
        let mut actual_packet = package_json["payloads"]
            [package_json["entrypoints"]["renderPacket"]
                .as_str()
                .unwrap()]
        .clone();
        for material in actual_packet["materials"].as_array_mut().unwrap() {
            let object = material.as_object_mut().unwrap();
            object.remove("shadingModel");
            object.insert("metallic".into(), json!(0));
            object.insert("roughness".into(), json!(0.8));
            object.insert("ior".into(), json!(1.5));
            object.insert("emissiveFactor".into(), json!([0, 0, 0]));
            object.insert("fog".into(), json!(false));
        }
        let scenarios = ["zero", "z-ramp", "checker"];
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
            assert!(matches!(
                adapter.get_info().device_type,
                wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
            ));
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let mut frames = vec![];
            let mut probe_inputs = vec![];
            for scenario in scenarios {
                let packet = serde_json::from_value(actual_packet.clone()).unwrap();
                let mut content = PlayerContent::from_packet(packet, None);
                for mip in content
                    .environment
                    .specular
                    .mips
                    .iter_mut()
                    .chain(content.environment.diffuse.mips.iter_mut())
                {
                    mip.texels.fill([0.0, 0.0, 0.0, 1.0]);
                }
                content
                    .environment
                    .brdf_lut
                    .texels
                    .fill([0.75, 0.0625, 0.0, 1.0]);
                content.probe_grid_records = Some(records(&f, scenario));
                let packed = deep_engine_native::probe_gi_grid::pack_cascade_records(
                    content.probe_grid_records.as_ref().unwrap(),
                )
                .unwrap();
                probe_inputs.push(
                    json!({"id":scenario,"packedBytes":packed,"packedHash":hash::sha256(&packed)}),
                );
                for camera in m["cameras"].as_array().unwrap() {
                    let plan_camera = points
                        .iter()
                        .find(|c| c.id == camera["id"].as_str().unwrap())
                        .unwrap_or_else(|| panic!("plan camera {} missing", camera["id"]));
                    let view = PlayerView {
                        focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan())
                            as f32,
                        near: camera["near"].as_f64().unwrap() as f32,
                        far: camera["far"].as_f64().unwrap() as f32,
                        ..Default::default()
                    }
                    .with_eye_target(vec3(&camera["eye"]), vec3(&camera["target"]))
                    .unwrap();
                    let configure = |frame: &mut FrameUniform| {
                        frame[9][3] = 1.0;
                        frame[11] = [0.0, 1.0, 0.0, if scenario == "zero" { 0.0 } else { 2.0 }];
                        frame[12][3] = 0.0;
                        frame[13] = [0.0, 0.0, 0.0, 1.0];
                        frame[14] = [1.0, 0.0, 0.0, 0.0];
                    };
                    for round in 0..2 {
                        let mut vp = vec![];
                        let mut actual_frame = vec![];
                        let snapshot = render_with_frame_observation(
                            &device,
                            &queue,
                            &content,
                            &mut FrameObservation {
                                capture_normals: false,
                                shadow_options: Some(CascadedShadowOptions {
                                    cascade_count: 2,
                                    shadow_map_size: 64,
                                    max_shadow_distance: 40.0,
                                    split_lambda: 0.7,
                                    depth_padding: 10.0,
                                    blend_ratio: 0.0,
                                }),
                                size: PhysicalSize::new(
                                    m["width"].as_u64().unwrap() as u32,
                                    m["height"].as_u64().unwrap() as u32,
                                ),
                                view,
                                configure: Some(&configure),
                                encode: &mut |_, _, _, frame, _| {
                                    vp = frame[..4].iter().flatten().copied().collect();
                                    actual_frame =
                                        frame.iter().flatten().copied().collect::<Vec<_>>();
                                },
                            },
                        )
                        .await;
                        let pixels = hdr::rgb(&snapshot.hdr);
                        let tolerance = f["absoluteTolerance"].as_f64().unwrap() as f32;
                        for point in &plan_camera.points {
                            let sampled = deep_engine_native::probe_gi_grid::sample_probe_grid_irradiance(
                                content.probe_grid_records.as_ref().unwrap(),
                                point.world,
                                point.normal,
                            );
                            for lane in 0..3 {
                                let expected = point.base[lane] * sampled[lane]
                                    / std::f32::consts::PI;
                                let observed = pixels[point.pixel * 3 + lane];
                                assert!(
                                    (observed - expected).abs() <= tolerance,
                                    "aniso native storage oracle failed at pixel {}/{lane} scenario {scenario}: {observed} vs {expected}",
                                    point.pixel
                                );
                            }
                        }
                        let samples = plan_camera.points.iter().map(|point| {
                            let i = point.pixel;
                            json!({"pixel":i,"hdr":[pixels[i*3],pixels[i*3+1],pixels[i*3+2],deep_engine_native::half_decode::half_to_f32(u16::from_le_bytes([snapshot.hdr[i*8+6],snapshot.hdr[i*8+7]]))]})
                        }).collect::<Vec<_>>();
                        let lanes = snapshot
                            .hdr
                            .chunks_exact(2)
                            .map(|p| u16::from_le_bytes([p[0], p[1]]).to_string())
                            .collect::<Vec<_>>()
                            .join(",");
                        frames.push(json!({"cameraId":camera["id"],"scenario":scenario,"round":round,"samples":samples,"rgbaHash":hash::sha256(lanes.as_bytes()),"vp":vp,"frameHash":hash::sha256(&serde_json::to_vec(&actual_frame).unwrap()),"frameJson":serde_json::to_string(&actual_frame).unwrap(),"frame":actual_frame}));
                    }
                }
            }
            runs.push(json!({"freshInstance":fresh,"frames":frames,"probeInputs":probe_inputs}));
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/probe-gi-aniso");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("native.json"),serde_json::to_vec_pretty(&json!({"passed":true,"packageHash":m["packageHash"],"packetHash":m["packetHash"],"actualPacketHash":hash::sha256(&serde_json::to_vec(&actual_packet).unwrap()),"actualPacketJson":serde_json::to_string(&actual_packet).unwrap(),"actualPacket":actual_packet,"profileHash":hash::sha256(FIXTURE.as_bytes()),"sourceAssembly":{"factory":"native_mesh_wgsl::native_mesh_shader_source","vertex":"vertex_main","fragment":"fragment_main"},"sourceHash":hash::sha256(deep_engine_native::native_mesh_wgsl::native_mesh_shader_source().as_bytes()),"runs":runs,"errors":[],"scope":"FrameObservation actual raster authored aniso grid binding, producer/init excluded; two fresh devices, three scenarios, formal CPU sampler expectations"})).unwrap()).unwrap();
    });
}
