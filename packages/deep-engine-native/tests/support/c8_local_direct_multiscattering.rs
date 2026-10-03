use crate::c8_direct_multiscattering::{
    BASE_COLOR, FROZEN_DFG_FILL, MANIFEST, METALLIC, PACKAGE, ROUGHNESS, ZERO_DFG_FILL,
    hdr_frame, multiscattering_energy, vector,
};
use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    half_decode::half_to_f32, mesh_abi::FrameUniform, pbr_brdf::direct_brdf,
    player_view::PlayerView, runtime_package::parse_and_validate_runtime_package,
    scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;

const CASES: [&str; 9] = [
    "directional",
    "point",
    "spot",
    "zero",
    "directional-back",
    "point-back",
    "outside-range",
    "reversed-cone",
    "hemisphere",
];
const RADIANCE: [f64; 3] = [2.5, 2.4, 2.25];
// 零直射控制:冻结稳定域内几何/衰减/锥形使直射恒为零。
const ZERO_DIRECT_CASES: [&str; 5] = [
    "zero",
    "directional-back",
    "point-back",
    "outside-range",
    "reversed-cone",
];
// hemisphere 的非直射贡献也有独立 Lambert 参考，仍参与填充解耦门。
const DIRECTED_CASES: [&str; 3] = ["directional", "point", "spot"];

fn lighting_with_radiance(case: &str, radiance: [f64; 3]) -> DirectionalLighting {
    let kind = match case {
        "directional" | "directional-back" => "directional",
        "spot" | "reversed-cone" => "spot",
        "hemisphere" => "hemisphere",
        "point" | "zero" | "point-back" | "outside-range" => "point",
        _ => panic!("unknown local energy case"),
    };
    let mut local = json!({"kind":kind,"position":[0,0,if case=="point-back" {-4} else {4}],
        "direction":if kind=="directional" {vec![-0.6,-0.3,if case=="directional-back" {-0.55_f64.sqrt()} else {0.55_f64.sqrt()}]}
            else {vec![0.0,0.0,if kind=="spot" && case!="reversed-cone" {-1.0} else {1.0}]},
        "radiance":radiance,
        "range":if case=="outside-range" {0.01} else if kind=="point" || kind=="spot" {20.0} else {0.0},
        "decay":2,"innerCos":0.9,"outerCos":0.5,"castShadow":false});
    if kind == "hemisphere" {
        local["groundRadiance"] = json!([0, 0, 0]);
    }
    let value: DirectionalLighting = serde_json::from_value(json!({
        "direction":[0,0,1],"radiance":[0,0,0],"exposure":1,"shadows":false,"localLights":[local]
    }))
    .unwrap();
    value.validate().unwrap()
}

fn lighting(case: &str) -> DirectionalLighting {
    lighting_with_radiance(case, if case == "zero" { [0.0; 3] } else { RADIANCE })
}

/// 同几何/同槽位的零辐射孪生:差分基线(灯关,主太阳本来就是 0)。
fn lighting_dark(case: &str) -> DirectionalLighting {
    lighting_with_radiance(case, [0.0; 3])
}

// f64 ray/plane intersection, not GPU outputs or production attenuation helpers.
// C8-S9:期望 = 完整本地直射 = 单散射 GGX(pbr_brdf::direct_brdf,含 nl 因子)
// + r185 双查表多散射(·nl),同乘 radiance·attenuation;DFG 来源是 twin 查表
// (dfg_view=dfg185(rough,nv) 懒采样,dfg_light=dfg185(rough,nl)),不再是注入常量。
fn expected_delta(case: &str, pixel: usize, focal: f32, lane: usize) -> f64 {
    if case == "hemisphere" {
        // Frozen normal and sky direction are both +Z: sky weight is exactly 1.
        return RADIANCE[lane] * BASE_COLOR[lane] * (1.0 - METALLIC)
            / std::f64::consts::PI;
    }
    if !DIRECTED_CASES.contains(&case) {
        return 0.0;
    }
    // 128×128 轴向相机(eye [0,0,8],GPU 腿已断言)打在 z=0 平面。
    let x = ((pixel % 128) as f64 + 0.5) / 128.0 * 2.0 - 1.0;
    let y = 1.0 - ((pixel / 128) as f64 + 0.5) / 128.0 * 2.0;
    let world_x = x * 8.0 / f64::from(focal);
    let world_y = y * 8.0 / f64::from(focal);
    let eye_length = (world_x * world_x + world_y * world_y + 64.0).sqrt();
    let view_direction = [-world_x / eye_length, -world_y / eye_length, 8.0 / eye_length];
    let nv = (8.0 / eye_length).clamp(0.001, 1.0);
    let (nl, attenuation, light_direction) = if case == "directional" {
        let nl = 0.55_f64.sqrt();
        (nl, 1.0, [-0.6, -0.3, nl])
    } else {
        let distance_squared = world_x * world_x + world_y * world_y + 16.0;
        let nl = 4.0 / distance_squared.sqrt();
        let cutoff = (1.0 - (distance_squared / 400.0).powi(2)).max(0.0).powi(2);
        let cone = if case == "spot" {
            let t = ((nl - 0.5) / (0.9 - 0.5)).clamp(0.0, 1.0);
            t * t * (3.0 - 2.0 * t)
        } else {
            1.0
        };
        let length = distance_squared.sqrt();
        (
            nl,
            cutoff / distance_squared * cone,
            [-world_x / length, -world_y / length, 4.0 / length],
        )
    };
    let ggx = direct_brdf(
        [0.0, 0.0, 1.0],
        view_direction,
        light_direction,
        BASE_COLOR,
        METALLIC,
        ROUGHNESS,
    );
    let f0 = 0.04 * (1.0 - METALLIC) + BASE_COLOR[lane] * METALLIC;
    (ggx[lane] + multiscattering_energy(f0, ROUGHNESS, nv, nl.clamp(0.0, 1.0)) * nl)
        * RADIANCE[lane]
        * attenuation
}

#[test]
fn local_energy_fixture_has_primary_zero_author_mode_three() {
    for case in CASES {
        let value = lighting(case);
        let mut frame = [[0.0; 4]; deep_engine_native::mesh_abi::FRAME_UNIFORM_FLOATS / 4];
        value.apply(&mut frame);
        assert_eq!(frame[13], [0.0, 0.0, 0.0, 3.0]);
        assert_eq!(frame[14][2], 1.0);
        assert!(frame[16][3] >= 1.0 && frame[16][3] <= 4.0);
        for lane in 0..3 {
            let delta = expected_delta(case, 8000, 1.8304877, lane);
            assert!(delta.is_finite() && delta >= 0.0);
            assert_eq!(delta > 0.0, DIRECTED_CASES.contains(&case));
        }
    }
}

#[test]
#[ignore = "actual production local energy, two fresh devices and r185-DFG full-direct oracle"]
fn c8_actual_local_direct_multiscattering() {
    let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-output/interrupted-0930/c8-native-local-energy");
    std::fs::create_dir_all(&output).unwrap();
    let evidence = output.join("evidence.json");
    if let Err(error) = std::fs::remove_file(&evidence) {
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
    pollster::block_on(async {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let camera = manifest["cameras"]
            .as_array()
            .unwrap()
            .iter()
            .find(|camera| camera["id"] == "axis")
            .unwrap();
        let view = PlayerView {
            focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan()) as f32,
            near: 0.1,
            far: 40.0,
            ..Default::default()
        }
        .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
        .unwrap();
        assert_eq!(view.eye(), [0.0, 0.0, 8.0]);
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
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
        let mut rounds = Vec::new();
        let mut maximum = 0.0_f64;
        for round in 0..2 {
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let mut cases = Vec::new();
            for case in CASES {
                let light = lighting(case);
                let dark = lighting_dark(case);
                // 每个 case 四帧:[case×185冻结填充, case×零填充, dark×185冻结填充, dark×零填充]。
                // 1) 解耦合同:case 与 dark 的两个填充整帧逐位相等(直射不再消费
                //    brdf_lut,IBL 已被 frame[9][3]=0 关闭);
                // 2) 灯开关合同:控制 case(零辐射/背光/超距/锥反/半球)必须与暗孪生
                //    整帧逐位相等;directed case 的 case−dark 差分 = 完整本地直射
                //    (GGX 单散射 + r185 双查表多散射)·radiance·attenuation。
                let mut hdr = Vec::new();
                let mut actual_frames = Vec::new();
                for (value, dfg) in [
                    (&light, FROZEN_DFG_FILL),
                    (&light, ZERO_DFG_FILL),
                    (&dark, FROZEN_DFG_FILL),
                    (&dark, ZERO_DFG_FILL),
                ] {
                    let configure = |frame: &mut FrameUniform| {
                        value.apply(frame);
                        frame[9][3] = 0.0;
                    };
                    let mut content = PlayerContent::from_package(
                        parse_and_validate_runtime_package(PACKAGE).unwrap(),
                    )
                    .unwrap();
                    content.environment.brdf_lut.texels.fill(dfg);
                    let snapshot = render_with_frame_observation(
                        &device,
                        &queue,
                        &content,
                        &mut FrameObservation {
                            capture_normals: false,
                            shadow_options: None,
                            size: PhysicalSize::new(128, 128),
                            view,
                            configure: Some(&configure),
                            encode: &mut |_device, _encoder, targets, frame, _shadow| {
                                assert!(targets.resolved_normal_texture().is_none());
                                assert_eq!(frame[13], [0.0, 0.0, 0.0, 3.0]);
                                assert_eq!(frame[14][2], 1.0);
                                assert_eq!(frame[9][3], 0.0);
                                actual_frames.push(frame[11..19].to_vec());
                            },
                        },
                    )
                    .await;
                    assert_eq!(snapshot.hdr.len(), 128 * 128 * 8);
                    hdr.push(snapshot.hdr);
                }
                assert_eq!(actual_frames.len(), 4);
                assert_eq!(actual_frames[0], actual_frames[1]);
                assert_eq!(actual_frames[2], actual_frames[3]);
                assert!(
                    hdr[0] == hdr[1],
                    "brdf_lut fill must not reach native local direct output {case}"
                );
                assert!(
                    hdr[2] == hdr[3],
                    "brdf_lut fill must not reach native local direct output (dark) {case}"
                );
                let directed = DIRECTED_CASES.contains(&case);
                // Backlight/range/cone controls describe the manifest's frozen
                // front-facing domain, not every other face in the whole frame.
                let mut samples = Vec::new();
                for subset in camera["subsets"].as_array().unwrap() {
                    assert_eq!(subset["materialId"], "golden-copper");
                    for pixel in subset["pixels"].as_array().unwrap() {
                        let pixel = pixel.as_u64().unwrap() as usize;
                        if ZERO_DIRECT_CASES.contains(&case) {
                            assert!(
                                hdr[0][pixel * 8..pixel * 8 + 8]
                                    == hdr[2][pixel * 8..pixel * 8 + 8],
                                "control case must equal its dark twin {case}/{pixel}"
                            );
                        }
                        let values:Vec<_>=(0..3).map(|lane| {
                            let offset=pixel*8+lane*2;
                            let decode=|bytes:&[u8]| f64::from(half_to_f32(u16::from_le_bytes([bytes[offset],bytes[offset+1]])));
                            let lit=decode(&hdr[0]); let dark=decode(&hdr[2]); let expected=expected_delta(case,pixel,view.focal,lane);
                            let error=(lit-dark-expected).abs(); maximum=maximum.max(error);
                            assert!(lit.is_finite() && dark.is_finite());
                            assert!(error<=0.002,"round={round} case={case} pixel={pixel} lane={lane} delta={} expected={expected} error={error}",lit-dark);
                            if directed { assert!(lit>dark,"missing actual local supplement {case}/{pixel}/{lane}"); }
                            else if ZERO_DIRECT_CASES.contains(&case) { assert_eq!(lit,dark,"zero/control depends on DFG {case}"); }
                            json!({"lit":lit,"dark":dark,"expected":expected,"error":error})
                        }).collect();
                        samples.push(
                            json!({"pixel":pixel,"instance":subset["instanceId"],"rgb":values}),
                        );
                    }
                }
                assert!(!samples.is_empty());
                cases.push(
                    json!({"case":case,"actualFrameLighting":actual_frames,"samples":samples}),
                );
            }
            device.destroy();
            rounds.push(cases);
        }
        assert_eq!(rounds[0], rounds[1]);
        std::fs::write(&evidence,serde_json::to_string_pretty(&json!({
            "passed":true,"stable":true,"freshDevices":2,"actualProductionHdr":true,"actualFrames":72,
            "adapter":format!("{info:?}"),"source":hdr_frame::shader_source(),"packageHash":manifest["packageHash"],
            "packetHash":manifest["packetHash"],"budget":0.002,"maxError":maximum,"rounds":rounds,
            "scope":"author primary RGB0/mode3; local directional/point/spot canonical energy with independent f64 full-direct oracle (GGX + r185 twin multiscattering), brdf_lut fill decoupling",
            "excluded":["default DFG profile equivalence","RT hardware","cluster selection correctness","complete Studio visual quality","performance"]
        })).unwrap()).unwrap();
    });
}
