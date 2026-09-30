#[path = "../src/half_float.rs"]
mod half_float;
#[path = "support/native_output_profile_draw.rs"]
mod native_output_profile_draw;
#[path = "../src/output_pass.rs"]
#[allow(dead_code)]
mod output_pass;
use native_output_profile_draw::draw;

use deep_engine_native::{
    author_grading::AuthorGrading,
    half_decode::half_to_f32,
    output_color_profile::{OutputColorProfile, display_srgb, three_background_linear},
    runtime_package::{
        parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
    },
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn package(profile: Option<Value>) -> Value {
    let mut package: Value =
        serde_json::from_str(include_str!("fixtures/runtime-package-shader-v2.json")).unwrap();
    let old_id = package["entrypoints"]["environment"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut environment = json!({"schema":"deep-engine.solid-environment","schemaVersion":1,"id":"scene.environment",
        "revision":1,"kind":"solid-background-no-ibl","backgroundSrgb":[0.0,0.5,1.0],"outputTransform":"native-aces-v1"});
    if let Some(profile) = profile {
        environment["displayProfile"] = profile;
    }
    package["payloads"].as_object_mut().unwrap().remove(&old_id);
    package["payloads"]["scene.environment"] = environment.clone();
    package["entrypoints"]["environment"] = json!("scene.environment");
    let resource = package["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|r| r["id"] == old_id)
        .unwrap();
    resource["id"] = json!("scene.environment");
    resource["contentHash"]["value"] = json!(runtime_content_sha256(&environment));
    package["resources"]
        .as_array_mut()
        .unwrap()
        .sort_by(|left, right| {
            left["id"]
                .as_str()
                .unwrap()
                .cmp(right["id"].as_str().unwrap())
        });
    package["packageHash"]["value"] = json!(runtime_package_sha256(&package).unwrap());
    package
}

#[test]
fn real_package_parser_preserves_default_and_consumes_optional_profile() {
    for profile in [
        None,
        Some(json!("deep-aces")),
        Some(json!("three-aces-r185")),
    ] {
        let loaded = parse_and_validate_runtime_package(
            &serde_json::to_vec(&package(profile.clone())).unwrap(),
        )
        .unwrap();
        let selected = if profile == Some(json!("three-aces-r185")) {
            OutputColorProfile::ThreeAcesR185
        } else {
            OutputColorProfile::DeepAces
        };
        assert_eq!(loaded.display_profile, selected);
        let display = display_srgb(loaded.background.unwrap(), selected);
        for (actual, expected) in display.into_iter().zip([0.0, 0.5, 1.0]) {
            assert!((actual - expected).abs() < 1e-10);
        }
        assert!(loaded.author_grading.is_none());
    }
    for profile in [
        json!(null),
        json!(1),
        json!("native-aces-v1"),
        json!("unknown"),
    ] {
        assert!(
            parse_and_validate_runtime_package(
                &serde_json::to_vec(&package(Some(profile))).unwrap()
            )
            .is_err()
        );
    }
}

#[test]
fn profile_selection_preserves_assembled_body_and_specializes_only_the_shim_call() {
    let display = include_str!("../../deep-engine/wgsl/displayColor.wgsl");
    let author = include_str!("../assets/shaders/native_output_color.wgsl");
    for (bloom, fog, variant) in [
        (
            false,
            false,
            include_str!("../assets/shaders/native_output_v1.wgsl"),
        ),
        (
            true,
            false,
            include_str!("../assets/shaders/native_output_bloom_v1.wgsl"),
        ),
        (
            false,
            true,
            include_str!("../assets/shaders/native_output_fog_v1.wgsl"),
        ),
        (
            true,
            true,
            include_str!("../assets/shaders/native_output_bloom_fog_v1.wgsl"),
        ),
    ] {
        // Later Fog common-math extraction intentionally changes Fog bytes;
        // profile selection must still change only the ACES shim call.
        let variant = if fog {
            [
                include_str!("../../deep-engine/wgsl/fogOpticalDepth.wgsl"),
                variant,
            ]
            .join("\n")
        } else {
            variant.to_owned()
        };
        let expected = [display, author, &variant].join("\n");
        assert_eq!(output_pass::output_shader(bloom, fog), expected);
        let three =
            output_pass::output_shader_with_profile(bloom, fog, OutputColorProfile::ThreeAcesR185);
        assert_eq!(
            three.replace(
                "return deepThreeAcesFit(color, 1.0);",
                "return deepAcesFit(color, 1.0);"
            ),
            expected
        );
    }
}

const BACKGROUNDS: [[f64; 3]; 8] = [
    [0.0; 3],
    [1.0; 3],
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [0.5; 3],
    [0.1, 0.2, 0.3],
    [0.0, 0.5, 1.0],
];
const GPU_TOLERANCE: f64 = 0.002; // Existing RGBA16F output gate, fixed before running.

#[test]
#[ignore = "requires actual hardware wgpu; root runs serial GPU validation"]
fn actual_gpu_profiles_preserve_backgrounds_grading_and_all_four_variants() {
    pollster::block_on(async {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN | wgpu::Backends::DX12;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                force_fallback_adapter: false,
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured = errors.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            captured.lock().unwrap().push(error.to_string())
        }));
        let mut maximum_error: f64 = 0.0;
        let mut samples = 0;
        for _round in 0..2 {
            for profile in [
                OutputColorProfile::DeepAces,
                OutputColorProfile::ThreeAcesR185,
            ] {
                for bloom in [false, true] {
                    for fog in [false, true] {
                        for expected in BACKGROUNDS {
                            let source = if profile == OutputColorProfile::ThreeAcesR185 {
                                three_background_linear(expected)
                            } else {
                                expected.map(|v| {
                                    let y = if v <= 0.04045 {
                                        v / 12.92
                                    } else {
                                        ((v + 0.055) / 1.055).powf(2.4)
                                    };
                                    let a = 2.51 - 2.43 * y;
                                    let b = 0.03 - 0.59 * y;
                                    (-b + (b * b + 0.56 * a * y).sqrt()) / (2.0 * a)
                                })
                            };
                            let actual = draw(&device, &queue, source, profile, bloom, fog, None);
                            let error = (0..3)
                                .map(|i| (actual[i] - expected[i]).abs())
                                .fold(0.0, f64::max);
                            maximum_error = maximum_error.max(error);
                            samples += 1;
                            assert!(
                                error <= GPU_TOLERANCE,
                                "background {expected:?} profile {profile:?} error {error}"
                            );
                            assert_eq!(actual[3], 0.5);
                        }
                        for source in [[0.4, 0.2, 0.1], [8.0, 1.0, 0.2], [64.0, 0.5, 2.0]] {
                            for grading in [
                                None,
                                Some(AuthorGrading::new(15.0, 0.2, -0.02, 0.1, 0.2, -0.3).unwrap()),
                            ] {
                                let actual = draw(
                                    &device,
                                    &queue,
                                    source,
                                    profile,
                                    bloom,
                                    fog,
                                    grading.map(|g| g.pack()),
                                );
                                let sampled =
                                    source.map(|c| half_to_f32(half_float::f32_to_f16(c as f32)));
                                let graded = grading.map(|g| g.apply(sampled)).unwrap_or(sampled);
                                let expected = display_srgb(graded.map(f64::from), profile);
                                let error = (0..3)
                                    .map(|i| (actual[i] - expected[i]).abs())
                                    .fold(0.0, f64::max);
                                maximum_error = maximum_error.max(error);
                                samples += 1;
                                assert!(
                                    error <= GPU_TOLERANCE,
                                    "HDR/grading {profile:?} error {error}"
                                );
                                assert_eq!(actual[3], 0.5);
                            }
                        }
                    }
                }
            }
        }
        assert!(errors.lock().unwrap().is_empty());
        println!(
            "native_output_profile GPU samples={samples} max_error={maximum_error} gpu_errors=0 adapter={:?}",
            adapter.get_info()
        );
    });
}
