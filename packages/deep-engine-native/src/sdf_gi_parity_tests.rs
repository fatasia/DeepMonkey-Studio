//! P1 native sdf-gi 双端对拍(TS 权威 fixture 的 Rust twin)。
//!
//! fixture 单源:`packages/deep-engine/fixtures/sdf-gi-native-parity-v1.json`
//! (生成器 `packages/deep-engine/scripts/generateSdfGiNativeParity.mts`,运行 TS
//! 生产 CPU 权威链:bakeSdfSceneGrid → deriveSdfGiProbeLattice →
//! traceSdfSkyVisibilityWithHits → updateProbeShWithSdfGi)。
//!
//! 对拍纪律:Rust 镜像按 f64 中间量 + Math.fround 落点逐式同构 → **位级对拍**
//! (f32 词逐字 + SHA-256(f32 LE);f64 标量逐位),无容差。唯二例外(跨 libm,
//! 如实声明):①coneTan = tan(π/12) 跨 libm ≤4 ulp sanity(追踪链消费 fixture
//! 权威标量);②targetEnergy 经 Math.hypot/hypot3 相对误差 ≤1e-9。

use crate::probe_gi_abi::PROBE_GI_RECORD_BYTES;
use crate::sdf_gi_probe_update::{
    ProbeShPreviousRecord, ProbeShUpdateInput, plan_sdf_gi_probe_window, probe_visibility_slice,
    record_to_abi, sdf_gi_probe_geometry_stats, update_probe_sh_with_sdf_gi,
};
use crate::sdf_gi_scene::{
    SdfInstanceDomain, SdfSceneBakeInstance, SdfSceneBakeInstanceStatus, SdfSceneBakeOptions,
    SdfSceneGrid, SdfSceneTransform, bake_sdf_scene_grid, derive_sdf_gi_probe_lattice,
    instance_max_extent, probe_lattice_bounds, resolve_sdf_gi_bake_cell_size,
};
use crate::sdf_gi_trace::{
    SdfSkyVisibilityTraceConfig, resolve_sdf_sky_visibility_trace_config,
    trace_sdf_sky_visibility_with_hits,
};
use crate::shader_package::hash::sha256;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../deep-engine/fixtures/sdf-gi-native-parity-v1.json");

fn fixture() -> &'static Value {
    use std::sync::OnceLock;
    static FIXTURE_PARSED: OnceLock<Value> = OnceLock::new();
    FIXTURE_PARSED.get_or_init(|| serde_json::from_str(FIXTURE).expect("fixture must parse"))
}

fn vector(value: &Value) -> [f64; 3] {
    std::array::from_fn(|index| value[index].as_f64().expect("fixture vec3"))
}

fn words(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("fixture words array")
        .iter()
        .map(|value| value.as_f64().expect("fixture word") as f32)
        .collect()
}

fn sha256_of(words: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(words.len() * 4);
    for word in words {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    sha256(&bytes)
}

/// fixture 实例的持有态(先解析后借用,规避生命周期)。
struct FixtureInstance {
    id: String,
    positions: Vec<f32>,
    indices: Vec<u32>,
    dynamic: bool,
    transform: Option<SdfSceneTransform>,
}

fn parse_instances(fixture: &Value) -> Vec<FixtureInstance> {
    fixture["inputs"]["instances"]
        .as_array()
        .expect("fixture instances")
        .iter()
        .map(|entry| {
            let transform = if entry["basis"].is_null() {
                None
            } else {
                let basis: Vec<f64> = entry["basis"]
                    .as_array()
                    .expect("basis")
                    .iter()
                    .map(|value| value.as_f64().expect("basis value"))
                    .collect();
                Some(SdfSceneTransform {
                    basis: std::array::from_fn(|index| basis[index]),
                    translation: vector(&entry["translation"]),
                })
            };
            FixtureInstance {
                id: entry["id"].as_str().expect("instance id").to_string(),
                positions: words(&entry["positions"]),
                indices: entry["indices"]
                    .as_array()
                    .expect("indices")
                    .iter()
                    .map(|index| index.as_u64().expect("index") as u32)
                    .collect(),
                dynamic: entry["dynamic"].as_bool().unwrap_or(false),
                transform,
            }
        })
        .collect()
}

fn instances_from(instances: &[FixtureInstance]) -> Vec<SdfSceneBakeInstance<'_>> {
    instances
        .iter()
        .map(|instance| SdfSceneBakeInstance {
            id: &instance.id,
            positions: &instance.positions,
            indices: &instance.indices,
            dynamic: instance.dynamic,
            transform: instance.transform.clone(),
        })
        .collect()
}

/// TS `SdfSceneBakeInstanceStatus` 词汇映射(报告行对拍)。
fn status_name(status: &SdfSceneBakeInstanceStatus) -> &'static str {
    match status {
        SdfSceneBakeInstanceStatus::Baked => "baked",
        SdfSceneBakeInstanceStatus::Cached => "cached",
        SdfSceneBakeInstanceStatus::DynamicExcluded => "dynamic-excluded",
        SdfSceneBakeInstanceStatus::Skipped => "skipped",
    }
}

#[test]
fn golden_bake_matches_ts_bitwise() {
    let fixture = fixture();
    let parsed = parse_instances(fixture);
    let borrowed = instances_from(&parsed);
    let (grid, report) = bake_sdf_scene_grid(
        &borrowed,
        SdfSceneBakeOptions {
            cell_size: fixture["inputs"]["cellSize"].as_f64().unwrap(),
            instance_domain: SdfInstanceDomain::Aabb,
            ..SdfSceneBakeOptions::default()
        },
    )
    .expect("golden scene must bake");
    let expected = &fixture["bake"];
    // 报告计数与逐实例状态(TS 报告按 id 升序)。
    let expected_report = &expected["report"];
    assert_eq!(
        report.baked_count,
        expected_report["bakedCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        report.excluded_dynamic_count,
        expected_report["excludedDynamicCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        report.skipped_count,
        expected_report["skippedCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        report.cached_count, 0,
        "native 权威链无缓存子集(模块头如实声明)"
    );
    let statuses = expected_report["instanceStatuses"].as_array().unwrap();
    assert_eq!(report.instances.len(), statuses.len());
    for (row, expected_row) in report.instances.iter().zip(statuses) {
        assert_eq!(row.id, expected_row["id"].as_str().unwrap());
        assert_eq!(
            status_name(&row.status),
            expected_row["status"].as_str().unwrap()
        );
        assert_eq!(
            row.triangles,
            expected_row["triangles"].as_u64().unwrap() as usize
        );
        assert_eq!(
            row.grid_cells.map_or(0, |cells| cells),
            expected_row["gridCells"].as_u64().unwrap_or(0) as usize
        );
    }
    // 网格几何(f64 逐位)。
    assert_eq!(grid.origin, vector(&expected["origin"]), "origin 逐位");
    assert_eq!(grid.cell_size, expected["cellSize"].as_f64().unwrap());
    let dimensions: Vec<usize> = expected["dimensions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_u64().unwrap() as usize)
        .collect();
    assert_eq!(
        grid.dimensions,
        [dimensions[0], dimensions[1], dimensions[2]]
    );
    // exteriorDistance:fround 落点(f32 位级)。
    assert_eq!(
        grid_distances(&grid).len(),
        expected["distancesWords"].as_array().unwrap().len()
    );
    let expected_exterior = expected["exteriorDistance"].as_f64().unwrap();
    assert_eq!(
        report.exterior_distance.to_bits(),
        (expected_exterior as f32).to_bits()
    );
    // 距离场:逐词位级 + SHA-256(f32 LE)。
    let distances = grid_distances(&grid);
    let expected_distances = words(&expected["distancesWords"]);
    for (index, (left, right)) in distances.iter().zip(&expected_distances).enumerate() {
        assert_eq!(
            left.to_bits(),
            right.to_bits(),
            "距离场 word {index} 位级漂移"
        );
    }
    assert_eq!(
        sha256_of(distances),
        expected["distancesSha256"].as_str().unwrap()
    );
}

fn grid_distances(grid: &SdfSceneGrid) -> &[f32] {
    &grid.distances
}

#[test]
fn golden_lattice_matches_ts_bitwise() {
    let fixture = fixture();
    let parsed = parse_instances(fixture);
    let borrowed = instances_from(&parsed);
    let (grid, _) = bake_sdf_scene_grid(
        &borrowed,
        SdfSceneBakeOptions {
            cell_size: fixture["inputs"]["cellSize"].as_f64().unwrap(),
            instance_domain: SdfInstanceDomain::Aabb,
            ..SdfSceneBakeOptions::default()
        },
    )
    .unwrap();
    let (bounds_min, bounds_max) = probe_lattice_bounds(&grid);
    assert_eq!(
        bounds_min,
        vector(&fixture["lattice"]["boundsMin"]),
        "lattice min 逐位"
    );
    assert_eq!(
        bounds_max,
        vector(&fixture["lattice"]["boundsMax"]),
        "lattice max 逐位"
    );
    let spacing = fixture["lattice"]["spacing"].as_f64().unwrap();
    let max_probes = 4096usize;
    let lattice = derive_sdf_gi_probe_lattice(bounds_min, bounds_max, spacing, max_probes)
        .expect("golden lattice");
    let expected_dimensions: Vec<usize> = fixture["lattice"]["dimensions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_u64().unwrap() as usize)
        .collect();
    assert_eq!(
        lattice.dimensions,
        [
            expected_dimensions[0],
            expected_dimensions[1],
            expected_dimensions[2]
        ]
    );
    assert_eq!(lattice.spacing, spacing);
    let expected_positions = fixture["lattice"]["positions"].as_array().unwrap();
    assert_eq!(lattice.positions.len(), expected_positions.len());
    for (position, expected) in lattice.positions.iter().zip(expected_positions) {
        assert_eq!(*position, vector(expected), "探针位置逐位");
    }
    // cellSize 解析缺省与 TS resolveSdfGiBakeCellSize 一致(extent/64 钳 [0.05,1])。
    let resolved = resolve_sdf_gi_bake_cell_size(&borrowed, None);
    assert!(
        (resolved - 0.05).abs() < 1e-12,
        "黄金场景 extent/64 → 钳下界,实测 {resolved}"
    );
    assert!(instance_max_extent(&borrowed) > 0.0);
}

#[test]
fn golden_trace_matches_ts_bitwise() {
    let fixture = fixture();
    let (grid, config) = golden_grid_and_config(fixture);
    let directions: Vec<[f64; 3]> = fixture["trace"]["directions"]
        .as_array()
        .unwrap()
        .iter()
        .map(vector)
        .collect();
    let positions: Vec<[f64; 3]> = fixture["lattice"]["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(vector)
        .collect();
    let (vis, hits) = trace_sdf_sky_visibility_with_hits(&grid, &positions, &directions, &config);
    let expected_vis = words(&fixture["trace"]["visibilitiesWords"]);
    let expected_hits = words(&fixture["trace"]["hitDistancesWords"]);
    for (index, (left, right)) in vis.iter().zip(&expected_vis).enumerate() {
        assert_eq!(
            left.to_bits(),
            right.to_bits(),
            "可见度 lane {index} 位级漂移"
        );
    }
    for (index, (left, right)) in hits.iter().zip(&expected_hits).enumerate() {
        assert_eq!(
            left.to_bits(),
            right.to_bits(),
            "命中距离 lane {index} 位级漂移"
        );
    }
    assert_eq!(
        sha256_of(&vis),
        fixture["trace"]["visibilitiesSha256"].as_str().unwrap()
    );
    assert_eq!(
        sha256_of(&hits),
        fixture["trace"]["hitDistancesSha256"].as_str().unwrap()
    );
    // 命中统计归约(f64 顺序累加,逐位)。
    let stats = sdf_gi_probe_geometry_stats(&hits, directions.len(), config.max_distance);
    let expected_stats = fixture["trace"]["geometryStats"].as_array().unwrap();
    assert_eq!(stats.len(), expected_stats.len());
    for (stat, expected) in stats.iter().zip(expected_stats) {
        assert_eq!(stat.0, expected[0].as_f64().unwrap(), "meanDistance 逐位");
        assert_eq!(
            stat.1,
            expected[1].as_f64().unwrap(),
            "distanceVariance 逐位"
        );
    }
}

/// 黄金网格 + 追踪配置(coneTan 跨 libm 用 fixture 权威标量;native resolve 做
/// ≤4 ulp sanity —— 跨 libm 如实声明,见模块头)。
fn golden_grid_and_config(fixture: &Value) -> (SdfSceneGrid, SdfSkyVisibilityTraceConfig) {
    let parsed = parse_instances(fixture);
    let borrowed = instances_from(&parsed);
    let (grid, _) = bake_sdf_scene_grid(
        &borrowed,
        SdfSceneBakeOptions {
            cell_size: fixture["inputs"]["cellSize"].as_f64().unwrap(),
            instance_domain: SdfInstanceDomain::Aabb,
            ..SdfSceneBakeOptions::default()
        },
    )
    .unwrap();
    let native_config = resolve_sdf_sky_visibility_trace_config(&grid, Default::default());
    let steps = fixture["trace"]["steps"].as_u64().unwrap() as u32;
    assert_eq!(native_config.steps, steps);
    let cone_tan = fixture["trace"]["coneTan"].as_f64().unwrap();
    let ulps = (native_config.cone_tan.to_bits() as i64 - cone_tan.to_bits() as i64).abs();
    assert!(ulps <= 4, "coneTan 跨 libm 发散超哨兵:{ulps} ulp");
    let max_distance = fixture["trace"]["maxDistance"].as_f64().unwrap();
    assert_eq!(
        native_config.max_distance.to_bits(),
        max_distance.to_bits(),
        "maxDistance(精确平方和)必须跨 libm 逐位"
    );
    (
        grid,
        SdfSkyVisibilityTraceConfig {
            steps,
            cone_tan,
            max_distance,
        },
    )
}

#[test]
fn golden_probe_update_matches_ts_bitwise() {
    let fixture = fixture();
    let (grid, config) = golden_grid_and_config(fixture);
    let directions: Vec<[f64; 3]> = fixture["trace"]["directions"]
        .as_array()
        .unwrap()
        .iter()
        .map(vector)
        .collect();
    let positions: Vec<[f64; 3]> = fixture["lattice"]["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(vector)
        .collect();
    let (vis, hits) = trace_sdf_sky_visibility_with_hits(&grid, &positions, &directions, &config);
    let stats = sdf_gi_probe_geometry_stats(&hits, directions.len(), config.max_distance);
    let sky = vector(&fixture["inputs"]["skyRadianceRgb"]);
    let sky_table = vec![sky; directions.len()];
    let albedo = vector(&fixture["inputs"]["bounceAlbedo"]);

    // ===== 第一帧:探针 0 埋入透传,其余首帧直取(bounce 开)=====
    let buried = &fixture["update"]["first"]["buriedPassthrough"];
    let buried_record = ProbeShPreviousRecord {
        irradiance: vector(&buried["irradiance"]),
        validity: buried["validity"].as_f64().unwrap(),
        mean_distance: buried["meanDistance"].as_f64().unwrap(),
        distance_variance: buried["distanceVariance"].as_f64().unwrap(),
        occlusion_floor: buried["occlusionFloor"].as_f64().unwrap(),
        position_offset: vector(&buried["positionOffset"]),
    };
    let previous: Vec<Option<ProbeShPreviousRecord>> = (0..positions.len())
        .map(|index| (index == 0).then_some(buried_record))
        .collect();
    let first = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
        previous: &previous,
        directions: &directions,
        visibilities: &vis,
        direction_sky_radiance: &sky_table,
        ssgdi: &[],
        bounce_albedo: Some(albedo),
        alpha: None,
        geometry_stats: Some(&stats),
    });
    let expected_first = &fixture["update"]["first"];
    assert_eq!(first.alpha, expected_first["alpha"].as_f64().unwrap());
    assert_eq!(
        first.bounce_sentinel_trips,
        expected_first["bounceSentinelTrips"].as_u64().unwrap() as usize
    );
    // targetEnergy 走 Math.hypot 跨 libm,按模块头声明的相对哨兵对拍。
    let expected_energy = expected_first["targetEnergy"].as_f64().unwrap();
    let energy_drift = ((first.target_energy - expected_energy) / expected_energy).abs();
    assert!(energy_drift <= 1e-9, "targetEnergy 相对漂移 {energy_drift}");
    assert_records_match(&first.records, &expected_first["recordsWords"]);
    assert_records_sha(
        &first.records,
        expected_first["recordsSha256"].as_str().unwrap(),
    );
    assert_sh_match(&first.sky_visibility_sh, &expected_first["skyVisibilitySh"]);
    // 埋入探针透传逐字段(f32 落盘面)。
    let passthrough = &first.records[0];
    assert_eq!(passthrough.irradiance, [0.05f32, 0.04, 0.03]);
    assert_eq!(passthrough.validity, 0.0);
    assert_eq!(passthrough.occlusion_floor, 0.5);
    assert_eq!(passthrough.position_offset, [0.01f32, 0.02, 0.03]);
    assert_eq!(first.sky_visibility_sh[0], None);

    // ===== 时域帧:previous = 第一帧 f64 链式面(TS 语义;f32 落盘面不回喂)=====
    let temporal_previous: Vec<Option<ProbeShPreviousRecord>> = first
        .records_f64
        .iter()
        .map(|record| Some(*record))
        .collect();
    let alpha = fixture["inputs"]["alphaTemporal"].as_f64().unwrap();
    let temporal = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
        previous: &temporal_previous,
        directions: &directions,
        visibilities: &vis,
        direction_sky_radiance: &sky_table,
        ssgdi: &[],
        bounce_albedo: None,
        alpha: Some(alpha),
        geometry_stats: Some(&stats),
    });
    let expected_temporal = &fixture["update"]["temporal"];
    assert_eq!(temporal.alpha, expected_temporal["alpha"].as_f64().unwrap());
    assert_eq!(
        temporal.bounce_sentinel_trips,
        expected_temporal["bounceSentinelTrips"].as_u64().unwrap() as usize
    );
    let expected_energy = expected_temporal["targetEnergy"].as_f64().unwrap();
    let energy_drift = ((temporal.target_energy - expected_energy) / expected_energy).abs();
    assert!(energy_drift <= 1e-9, "targetEnergy 相对漂移 {energy_drift}");
    assert_records_match(&temporal.records, &expected_temporal["recordsWords"]);
    assert_records_sha(
        &temporal.records,
        expected_temporal["recordsSha256"].as_str().unwrap(),
    );
    assert_sh_match(
        &temporal.sky_visibility_sh,
        &expected_temporal["skyVisibilitySh"],
    );
    // f64 链式面 = f32 落盘面的取值源(单源;cast 同构由 words 位级断言背书)。
    for (f64_record, abi_record) in temporal.records_f64.iter().zip(&temporal.records) {
        assert_eq!(record_to_abi(f64_record), *abi_record);
    }
}

#[test]
fn golden_window_plan_and_initial_records_match_ts() {
    let fixture = fixture();
    let (_, config) = golden_grid_and_config(fixture);
    let probe_count = fixture["lattice"]["positions"].as_array().unwrap().len();
    let budget = fixture["inputs"]["windowBudget"].as_f64().unwrap();
    let dispatched = fixture["inputs"]["windowDispatched"].as_u64().unwrap() as usize;
    let (offset, count) = plan_sdf_gi_probe_window(probe_count, budget, dispatched);
    assert_eq!(
        offset,
        fixture["trace"]["probeWindow"]["offset"].as_u64().unwrap() as usize
    );
    assert_eq!(
        count,
        fixture["trace"]["probeWindow"]["count"].as_u64().unwrap() as usize
    );
    // 烘焙期记录初值(96B ABI;有界 Chebyshev 先验)。
    let initial =
        crate::sdf_gi_probe_update::pack_initial_sdf_gi_records(probe_count, config.max_distance);
    let packed = crate::probe_gi_abi::pack_records(&initial).unwrap();
    let initial_words: Vec<f32> = packed
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    let expected = words(&fixture["update"]["initialRecordsWords"]);
    for (index, (left, right)) in initial_words.iter().zip(&expected).enumerate() {
        assert_eq!(
            left.to_bits(),
            right.to_bits(),
            "初值 word {index} 位级漂移"
        );
    }
    assert_eq!(
        sha256_of(&initial_words),
        fixture["update"]["initialRecordsSha256"].as_str().unwrap()
    );
    // 初值标量(有界可见先验)。
    assert_eq!(
        config.max_distance * 0.5,
        fixture["trace"]["initialMeanDistance"].as_f64().unwrap()
    );
    let expected_variance = fixture["trace"]["initialVariance"].as_f64().unwrap();
    assert_eq!(
        (config.max_distance * 0.25) * (config.max_distance * 0.25),
        expected_variance
    );
}

/// 逐探针 96B 记录词位级对拍(每记录 96B = 24 f32;ABI 字段序由 probe_gi_abi 保证)。
fn assert_records_match(records: &[crate::probe_gi_abi::IrradianceProbeRecord], expected: &Value) {
    let expected_records = expected.as_array().expect("recordsWords array");
    assert_eq!(records.len(), expected_records.len(), "探针数漂移");
    for (record, expected_words) in records.iter().zip(expected_records) {
        let bytes: &[u8] = bytemuck::bytes_of(record);
        assert_eq!(bytes.len(), crate::probe_gi_abi::PROBE_GI_RECORD_BYTES);
        let expected_record_words: Vec<f32> = words(expected_words);
        for (word_index, word) in expected_record_words.iter().enumerate() {
            let actual = f32::from_le_bytes(
                bytes[word_index * 4..word_index * 4 + 4]
                    .try_into()
                    .unwrap(),
            );
            assert_eq!(
                actual.to_bits(),
                word.to_bits(),
                "记录 word {word_index} 位级漂移(左 native 右 TS)"
            );
        }
        record
            .validate()
            .expect("更新记录必须通过 96B ABI validate");
    }
}

fn assert_records_sha(records: &[crate::probe_gi_abi::IrradianceProbeRecord], expected: &str) {
    let mut words = Vec::with_capacity(records.len() * PROBE_GI_RECORD_BYTES / 4);
    for record in records {
        let bytes: &[u8] = bytemuck::bytes_of(record);
        for chunk in bytes.chunks_exact(4) {
            words.push(f32::from_le_bytes(chunk.try_into().unwrap()));
        }
    }
    assert_eq!(sha256_of(&words), expected, "记录流 SHA-256(f32 LE)漂移");
}

fn assert_sh_match(sh: &[Option<[f64; 4]>], expected: &Value) {
    let expected_sh = expected.as_array().unwrap();
    assert_eq!(sh.len(), expected_sh.len());
    for (coefficients, expected) in sh.iter().zip(expected_sh) {
        match (coefficients, expected.as_array()) {
            (None, None) => {}
            (Some(values), Some(expected)) => {
                for (axis, value) in values.iter().enumerate() {
                    assert_eq!(*value, expected[axis].as_f64().unwrap(), "SH 系数逐位");
                }
            }
            (None, Some(_)) => panic!("TS SH 在场而 native 缺失"),
            (Some(_), None) => panic!("native SH 在场而 TS 缺失(埋入探针必须为 null)"),
        }
    }
}

#[test]
fn visibility_slices_align_with_lane_order() {
    // probeVisibilitySlice 的下标换算与 lane 序一致(探针主序 × 方向)。
    let visibilities: Vec<f32> = (0..48).map(|index| index as f32).collect();
    let slice = probe_visibility_slice(&visibilities, 2, 16);
    assert_eq!(slice, (32..48).map(f64::from).collect::<Vec<f64>>());
}
