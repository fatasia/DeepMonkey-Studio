//! Diagnostic function timing, not a second production renderer.
use crate::{telemetry::SampleToken, telemetry_gpu::GpuFrameTiming};
#[allow(dead_code)]
use deep_engine_native::shader_package::hash;
use serde_json::{Value, json};
#[allow(dead_code)]
#[path = "../tests/support/j2_csm_oracle.rs"]
mod oracle;
#[allow(dead_code)]
#[path = "../tests/support/lod_draw_readback.rs"]
mod readback;
#[path = "csm_sampling_timing_resources.rs"]
mod resources;
const PLAN: &str = include_str!("../../deep-engine/fixtures/j2-csm-timing-v1.json");
const ENTRY: &str = include_str!("../../deep-engine/fixtures/j2-csm-timing-entry.wgsl");
const MATH: &str = include_str!("../../deep-engine/wgsl/cascadedShadowMath.wgsl");
const NATIVE: &str = include_str!("../assets/shaders/native_cascaded_shadow_v1.wgsl");
#[test]
#[ignore = "real native GPU timestamp-query paired CSM function timing"]
fn j2_b4_actual_native_csm_timing() {
    pollster::block_on(async {
        let p: Value = serde_json::from_str(PLAN).unwrap();
        let fixture: Value = serde_json::from_str(oracle::FIXTURE).unwrap();
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
        let features =
            wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        let supported = adapter.features().contains(features);
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                required_features: if supported {
                    features
                } else {
                    wgpu::Features::empty()
                },
                ..Default::default()
            })
            .await
            .unwrap();
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let receiver = resources::Receiver::new(
            &device,
            &queue,
            p["width"].as_u64().unwrap() as u32,
            p["height"].as_u64().unwrap() as u32,
        );
        let original = format!("{MATH}\n{NATIVE}");
        let guarded = "return blendStart >= split || viewDepth <= blendStart;";
        assert_eq!(original.matches(guarded).count(), 1);
        let reference = original.replace(guarded, "return blendStart >= split;");
        let uvs = oracle::list(&fixture, "uvXs");
        let join = |values: &[f64]| {
            values
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(",")
        };
        let mut results = vec![];
        for row in p["cases"].as_array().unwrap() {
            let depths = oracle::list(row, "depths");
            let mut variants = vec![];
            let mut correctness = vec![];
            for (id, source) in [("reference", &reference), ("candidate", &original)] {
                let library = format!(
                    "struct ProbeFrame {{ eye: vec4f }};\nvar<private> frame: ProbeFrame;\n{}",
                    source.split_once("fn local_spot_pcss(").unwrap().0
                );
                let code = format!(
                    "{library}\n{}",
                    ENTRY
                        .replace("TIMING_DEPTHS", &join(&depths))
                        .replace("TIMING_UVS", &join(&uvs))
                );
                let (pipeline, group) = receiver.pipeline(&device, code.clone());
                let mut encoder = device.create_command_encoder(&Default::default());
                receiver.encode(
                    &mut encoder,
                    &pipeline,
                    &group,
                    p["drawsPerSample"].as_u64().unwrap() as u32,
                );
                let bytes = receiver.target.width() * 16;
                let staging = readback::staging(&device, bytes as u64);
                encoder.copy_texture_to_buffer(
                    receiver.target.as_image_copy(),
                    wgpu::TexelCopyBufferInfo {
                        buffer: &staging,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(bytes),
                            rows_per_image: Some(1),
                        },
                    },
                    wgpu::Extent3d {
                        width: receiver.target.width(),
                        height: 1,
                        depth_or_array_layers: 1,
                    },
                );
                queue.submit([encoder.finish()]);
                let raw = readback::mapped_bytes(&device, &staging);
                let lanes: &[f32] = bytemuck::cast_slice(&raw);
                let values = (0..21).map(|i| lanes[i * 4] as f64).collect::<Vec<_>>();
                let max_error = values
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        (v - oracle::visibility(
                            &fixture,
                            "linear",
                            false,
                            1.8,
                            depths[i % 3],
                            uvs[i % 7],
                        ))
                        .abs()
                    })
                    .fold(0f64, f64::max);
                assert!(max_error <= fixture["maxError"].as_f64().unwrap());
                correctness.push(json!({"id":id,"sourceHash":hash::sha256(code.as_bytes()),"libraryHash":hash::sha256(library.as_bytes()),"values":values,"maxError":max_error}));
                variants.push((id, pipeline, group));
            }
            let mut pairs = vec![];
            for round in 1..=5 {
                let mut windows = serde_json::Map::new();
                let order = if round % 2 == 1 {
                    ["reference", "candidate"]
                } else {
                    ["candidate", "reference"]
                };
                for id in order {
                    let (_, pipeline, group) = variants.iter().find(|v| v.0 == id).unwrap();
                    for _ in 0..p["warmupFrames"].as_u64().unwrap() {
                        let mut encoder = device.create_command_encoder(&Default::default());
                        receiver.encode(
                            &mut encoder,
                            pipeline,
                            group,
                            p["drawsPerSample"].as_u64().unwrap() as u32,
                        );
                        queue.submit([encoder.finish()]);
                        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
                    }
                    let start = std::time::Instant::now();
                    let token = SampleToken {
                        device_epoch: 1,
                        reset_generation: round,
                    };
                    let mut timing = supported.then(|| GpuFrameTiming::new(&device, &queue, 1));
                    for _ in 0..p["sampleFrames"].as_u64().unwrap() {
                        let mut encoder = device.create_command_encoder(&Default::default());
                        if let Some(t) = timing.as_mut() {
                            t.begin_frame(token, &mut encoder);
                        }
                        receiver.encode(
                            &mut encoder,
                            pipeline,
                            group,
                            p["drawsPerSample"].as_u64().unwrap() as u32,
                        );
                        if let Some(t) = timing.as_mut() {
                            t.finish_frame(token, &mut encoder);
                        }
                        queue.submit([encoder.finish()]);
                        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
                    }
                    let gpu = timing.map(|t| t.readback(&device, &queue, token));
                    let samples = gpu.as_ref().map(|g| g.frame_samples_ms()).unwrap_or(&[]);
                    let measured = samples.len() == p["sampleFrames"].as_u64().unwrap() as usize
                        && samples.iter().all(|v| v.is_finite() && *v > 0.);
                    let end = start.elapsed().as_secs_f64() * 1000.;
                    windows.insert(id.into(),json!({"schema":"deep-engine.benchmark-sample-window","schemaVersion":1,
                        "runId":format!("native-{}-{id}-{round}",row["id"].as_str().unwrap()),"clockId":"host-monotonic",
                        "windowStartMs":0.,"windowEndMs":end,"observedSamplesMs":samples,"channels":[{"channel":"gpu-timestamp","clockId":"gpu-timestamp",
                        "sampleCount":if measured {samples.len()} else {0},"samplesMs":if measured {samples} else {&[]},
                        "windowStartMs":0.,"windowEndMs":end,"availability":if measured {"measured"} else {"unavailable"},
                        "unavailableReason":if measured {None} else {Some(if supported {"timestamp_zero_quantization_or_incomplete_window"} else {"timestamp_query_unsupported"})}}]}));
                }
                pairs.push(json!({"round":round,"order":order,"reference":windows["reference"],"candidate":windows["candidate"]}));
            }
            results.push(json!({"id":row["id"],"correctness":correctness,"pairs":pairs}));
        }
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        assert!(scope.pop().await.is_none());
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/csm-timing");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("native.json"),serde_json::to_vec_pretty(&json!({"passed":true,"planHash":hash::sha256(PLAN.as_bytes()),
            "fixtureHash":hash::sha256(oracle::FIXTURE.as_bytes()),"adapter":format!("{:?}",adapter.get_info()),
            "results":results,"errors":[]})).unwrap()).unwrap();
    });
}
