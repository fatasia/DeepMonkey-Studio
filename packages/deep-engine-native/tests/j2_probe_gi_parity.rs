#[path = "support/j2_probe_gi_gpu.rs"]
mod gpu;
#[allow(dead_code)]
use deep_engine_native::shader_package::hash;

use deep_engine_native::{
    probe_gi_abi::IrradianceProbeRecord,
    probe_gi_grid::{ProbeGiGridHeader, ProbeGiGridLayoutHeader, sample_probe_grid_irradiance},
};
use hash::sha256;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../deep-engine/fixtures/j2-probe-gi-v1.json");
const NATIVE: &str = include_str!("../assets/shaders/native_mesh_v1.wgsl");

fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|index| value[index].as_f64().unwrap() as f32)
}

fn records(fixture: &Value, test: &Value) -> Vec<IrradianceProbeRecord> {
    let levels = fixture["levels"].as_array().unwrap();
    let fine_count = levels[0]["probeCount"].as_u64().unwrap() as usize;
    let probes: Vec<_> = fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let mut record = IrradianceProbeRecord::zero();
            record.irradiance = vector(&item["irradiance"]);
            record.validity = if index < fine_count {
                test["fineValidity"].as_f64()
            } else {
                None
            }
            .unwrap_or(item["validity"].as_f64().unwrap()) as f32;
            record.mean_distance = test["meanDistance"]
                .as_f64()
                .unwrap_or(item["meanDistance"].as_f64().unwrap())
                as f32;
            record.distance_variance = item["distanceVariance"].as_f64().unwrap() as f32;
            record.occlusion_floor = item["occlusionFloor"].as_f64().unwrap() as f32;
            record.position_offset = vector(if test["positionOffset"].is_array() {
                &test["positionOffset"]
            } else {
                &item["positionOffset"]
            });
            record.validate().unwrap();
            record
        })
        .collect();
    let mut stream = vec![
        ProbeGiGridLayoutHeader {
            level_count: levels.len() as u32,
            levels_start_record: 1,
        }
        .encode()
        .unwrap(),
    ];
    let mut base = 0;
    for level in levels {
        let count = level["probeCount"].as_u64().unwrap() as usize;
        let grid_size =
            std::array::from_fn(|index| level["gridSize"][index].as_u64().unwrap() as u32);
        let header = ProbeGiGridHeader {
            origin: vector(&level["origin"]),
            spacing: level["spacing"].as_f64().unwrap() as f32,
            grid_size,
            probe_count: count as u32,
        };
        stream.push(header.encode_with_base(stream.len() + 1).unwrap());
        stream.extend_from_slice(&probes[base..base + count]);
        base += count;
    }
    stream
}

fn shader() -> String {
    let prefix = NATIVE.split("fn section_rejected(").next().unwrap();
    let provider = deep_engine_native::probe_gi_wgsl::native_probe_sampling_wgsl();
    format!(
        "{prefix}\n{provider}\n@group(1) @binding(0) var<storage,read> receiver: array<vec4f>;\n@group(1) @binding(1) var<storage,read_write> result: array<vec4f>;\n@compute @workgroup_size(1) fn probeMain() {{ result[0] = vec4f(probe_gi_grid_trilinear(receiver[0].xyz, receiver[1].xyz),1); }}"
    )
}

#[test]
#[ignore = "real hardware GPU readback; invoked by the J2 probe parity runner"]
fn j2_probe_gi_production_vectors() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let code = shader();
    let (device, queue, adapter) = gpu::gpu();
    let tolerance = fixture["tolerance"].as_f64().unwrap() as f32;
    let mut results = Vec::new();
    for test in fixture["cases"].as_array().unwrap() {
        let stream = records(&fixture, test);
        let world = vector(&test["worldPosition"]);
        let normal = vector(&test["worldNormal"]);
        let input = [
            world[0], world[1], world[2], 0.0, normal[0], normal[1], normal[2], 0.0,
        ];
        let expected = sample_probe_grid_irradiance(&stream, world, normal);
        let first = gpu::sample(
            &device,
            &queue,
            &code,
            bytemuck::cast_slice(&stream),
            &input,
        );
        let second = gpu::sample(
            &device,
            &queue,
            &code,
            bytemuck::cast_slice(&stream),
            &input,
        );
        assert_eq!(first, second, "repeat {}", test["id"]);
        let max_error = first
            .iter()
            .zip(expected)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            first.iter().all(|value| value.is_finite()) && max_error <= tolerance,
            "{}: actual {first:?} expected {expected:?}, error {max_error}",
            test["id"]
        );
        results.push(json!({"id":test["id"],"value":first,"expected":expected,"maxError":max_error,"passed":true}));
    }
    let evidence = json!({"fixtureHash":sha256(FIXTURE.as_bytes()),"sourceHash":sha256(code.as_bytes()),
        "source":code,"sourceInputHashes":{
            "wrapper":sha256(NATIVE.as_bytes()),
            "kernel":sha256(deep_engine_native::probe_gi_wgsl::PROBE_CLIPMAP_SAMPLING_WGSL.as_bytes()),
            "adapter":sha256(include_str!("../src/probe_gi_wgsl.rs").as_bytes())},
        "adapter":adapter,"runs":2,"results":results,"passed":true,
        "scope":"Native wgpu production storage GI functions; not full frame"});
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-output/interrupted-0930/probe-gi-parity");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("native.json"),
        serde_json::to_string_pretty(&evidence).unwrap(),
    )
    .unwrap();
    println!("{evidence}");
}
