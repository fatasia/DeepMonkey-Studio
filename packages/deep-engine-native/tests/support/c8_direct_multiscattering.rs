use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    half_decode::half_to_f32, player_view::PlayerView,
    runtime_package::parse_and_validate_runtime_package, scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
#[path = "j3_hdr_frame.rs"]
mod hdr_frame;
const PACKAGE: &[u8] = include_bytes!("../fixtures/runtime-package-v1.json");
const MANIFEST: &str = include_str!("../../../deep-engine/fixtures/j3-hdr-flat-normal-v1.json");
fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
}
fn energy(f0: f64) -> f64 {
    let single = f0 * 0.5 + 0.04;
    let lost = 1.0 - (0.5 + 0.04);
    let average = f0 + (1.0 - f0) * 0.047619;
    single * single * average / (1.0 - lost * lost * average + 0.000001) * lost * lost
}
#[test]
#[ignore = "actual production HDR constant-DFG differential, two fresh hardware devices"]
fn c8_actual_primary_direct_multiscattering() {
    pollster::block_on(async {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
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
            for camera in manifest["cameras"].as_array().unwrap() {
                let view = PlayerView {
                    focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan())
                        as f32,
                    near: 0.1,
                    far: 40.0,
                    ..Default::default()
                }
                .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
                .unwrap();
                for mode in ["lit", "back", "off"] {
                    let direction = [
                        -0.6,
                        -0.3,
                        if mode == "back" {
                            -0.55_f32.sqrt()
                        } else {
                            0.55_f32.sqrt()
                        },
                    ];
                    let radiance = if mode == "off" {
                        [0.0; 3]
                    } else {
                        [2.5, 2.4, 2.25]
                    };
                    let configure = |frame: &mut deep_engine_native::mesh_abi::FrameUniform| {
                        let light: DirectionalLighting = serde_json::from_value(json!({
                            "direction":direction,"radiance":radiance,"exposure":1.0,"shadows":false
                        }))
                        .unwrap();
                        light.validate().unwrap().apply(frame);
                        frame[9][3] = 0.0;
                    };
                    let mut hdr = Vec::new();
                    for dfg in [[0.0, 0.0, 0.0, 1.0], [0.5, 0.04, 0.0, 1.0]] {
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
                                encode: &mut |_device, _encoder, targets, _frame, _shadow| {
                                    assert!(targets.resolved_normal_texture().is_none());
                                },
                            },
                        )
                        .await;
                        hdr.push(snapshot.hdr);
                    }
                    let mut samples = Vec::new();
                    for subset in camera["subsets"].as_array().unwrap() {
                        for pixel in subset["pixels"].as_array().unwrap() {
                            let pixel = pixel.as_u64().unwrap() as usize;
                            let base = [0.86, 0.28, 0.055];
                            let values: Vec<_> = (0..3).map(|lane| {
                                let offset = pixel*8+lane*2;
                                let decode = |bytes: &[u8]| half_to_f32(u16::from_le_bytes([bytes[offset],bytes[offset+1]])) as f64;
                                let before = decode(&hdr[0]); let after = decode(&hdr[1]);
                                let expected = if mode == "lit" { energy(0.04*(1.0-0.72)+base[lane]*0.72)*0.55_f64.sqrt()*radiance[lane] as f64 } else { 0.0 };
                                let error = (after-before-expected).abs(); maximum = maximum.max(error);
                                assert!(error <= 0.002, "round={round} mode={mode} pixel={pixel} lane={lane}: delta={} expected={expected} error={error}",after-before);
                                if mode != "lit" { assert_eq!(before,after); } else { assert!(after > before); }
                                json!({"before":before,"after":after,"expected":expected,"error":error})
                            }).collect();
                            samples.push(
                                json!({"pixel":pixel,"instance":subset["instanceId"],"rgb":values}),
                            );
                        }
                    }
                    cases.push(json!({"camera":camera["id"],"mode":mode,"samples":samples}));
                }
            }
            device.destroy();
            rounds.push(cases);
        }
        assert_eq!(rounds[0], rounds[1]);
        let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/c8-native-direct-energy");
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(output.join("evidence.json"), serde_json::to_string_pretty(&json!({
            "passed":true,"stable":true,"freshDevices":2,"actualProductionHdr":true,"adapter":format!("{info:?}"),
            "source":hdr_frame::shader_source(),"maxError":maximum,"budget":0.002,"rounds":rounds,
            "scope":"primary direct-energy consumption with constant-DFG differential, IBL disabled",
            "excluded":["default DFG profile equivalence","RT actual hardware","local lights","complete C8"]
        })).unwrap()).unwrap();
    });
}
