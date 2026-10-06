//! [`crate::sdf_gi_trace`] 单元测试:解析解遮蔽/开放天空 + Fibonacci 方向集 + 配置钳制。

use super::*;
use crate::sdf_gi_scene::{build_sdf_grid, fround};

/// 场景:单位盒 SDF(与解析测试同构;域 [-1,1]³,cellSize 0.5)。
fn box_grid() -> SdfSceneGrid {
    let p = |x: f64, y: f64, z: f64| [x as f32, y as f32, z as f32];
    let positions: Vec<f32> = [
        p(0., 0., 0.),
        p(1., 0., 0.),
        p(1., 1., 0.),
        p(0., 1., 0.),
        p(0., 0., 1.),
        p(1., 0., 1.),
        p(1., 1., 1.),
        p(0., 1., 1.),
    ]
    .concat();
    let indices: Vec<u32> = vec![
        2, 1, 0, 3, 2, 0, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 6, 2, 3, 6, 3, 7, 1, 2, 6, 1, 6, 5,
        3, 0, 4, 3, 4, 7,
    ];
    let distances =
        build_sdf_grid(&positions, &indices, [fround(-1.0); 3], 0.5, [5, 5, 5]).unwrap();
    SdfSceneGrid {
        origin: [-1.0; 3],
        cell_size: 0.5,
        dimensions: [5, 5, 5],
        distances,
    }
}

#[test]
fn out_of_domain_probe_is_open_sky() {
    let grid = box_grid();
    let config = resolve_sdf_sky_visibility_trace_config(
        &grid,
        SdfSkyVisibilityTraceOptions {
            steps: Some(8),
            ..SdfSkyVisibilityTraceOptions::default()
        },
    );
    let (vis, hits) = trace_sdf_sky_visibility_with_hits(
        &grid,
        &[[50.0, 50.0, 50.0]],
        &[[0.0, 1.0, 0.0]],
        &config,
    );
    assert_eq!(vis[0], 1.0);
    assert_eq!(hits[0], -1.0);
}

#[test]
fn direction_toward_wall_hits_at_analytic_step() {
    let grid = box_grid();
    let config = resolve_sdf_sky_visibility_trace_config(
        &grid,
        SdfSkyVisibilityTraceOptions {
            steps: Some(8),
            ..SdfSkyVisibilityTraceOptions::default()
        },
    );
    // 探针 (-1, 0, 0),方向 +X。轴线上烘焙场的真值(格点值 [1,0.5,0,0,0],
    // y=z=0 线上 trilinear 退化为沿 x 线性精确):x∈[-1,0] → |x|;x∈[0,1] → 0
    // (盒棱);x>1(域外)→ 1e6。首个 contribution<1 的步心 = 步 2
    // (x≈0.0825 落在零值段)。
    let step_length = fround(config.max_distance / 8.0);
    let expected_hit = fround(fround(2.0 + 0.5) * step_length);
    let (vis, hits) =
        trace_sdf_sky_visibility_with_hits(&grid, &[[-1.0, 0.0, 0.0]], &[[1.0, 0.0, 0.0]], &config);
    assert_eq!(hits[0], expected_hit as f32, "首个侵入步心必须是步 2 的 t");
    assert_eq!(vis[0], 0.0, "轴向直达盒棱 → 全遮蔽");
}

#[test]
fn opposite_direction_stays_open() {
    let grid = box_grid();
    let config = resolve_sdf_sky_visibility_trace_config(
        &grid,
        SdfSkyVisibilityTraceOptions {
            steps: Some(8),
            ..SdfSkyVisibilityTraceOptions::default()
        },
    );
    // 探针 (-1, 0, 0),方向 −X 背离场景(出域 → 开放天空,采样恒 1e6)。
    let (vis, hits) = trace_sdf_sky_visibility_with_hits(
        &grid,
        &[[-1.0, 0.0, 0.0]],
        &[[-1.0, 0.0, 0.0]],
        &config,
    );
    assert_eq!(vis[0], 1.0);
    assert_eq!(hits[0], -1.0);
}

#[test]
fn non_unit_direction_is_normalized() {
    let grid = box_grid();
    let config = resolve_sdf_sky_visibility_trace_config(
        &grid,
        SdfSkyVisibilityTraceOptions {
            steps: Some(8),
            ..SdfSkyVisibilityTraceOptions::default()
        },
    );
    let (unit, _) =
        trace_sdf_sky_visibility_with_hits(&grid, &[[-1.0, 0.0, 0.0]], &[[4.0, 0.0, 0.0]], &config);
    let (scaled, _) =
        trace_sdf_sky_visibility_with_hits(&grid, &[[-1.0, 0.0, 0.0]], &[[1.0, 0.0, 0.0]], &config);
    assert_eq!(unit, scaled);
}

#[test]
fn fibonacci_directions_are_unit_and_balanced() {
    for count in [16u32, 32] {
        let mut sum = [0.0f64; 3];
        for ordinal in 0..count {
            let d = probe_occlusion_direction(ordinal, count);
            let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            assert!((length - 1.0).abs() < 1e-12);
            for axis in 0..3 {
                sum[axis] += d[axis];
            }
        }
        // 均匀球面集质心趋近原点。
        for value in sum {
            assert!(value.abs() < 0.2, "Fibonacci 方向集失衡:{value}");
        }
    }
}

#[test]
fn config_resolution_clamps_fail_closed() {
    let grid = box_grid();
    let config = resolve_sdf_sky_visibility_trace_config(
        &grid,
        SdfSkyVisibilityTraceOptions {
            steps: Some(4),
            cone_tan: Some(2.0),
            max_distance: Some(-1.0),
        },
    );
    assert_eq!(config.steps, SDF_SKY_VISIBILITY_MIN_STEPS);
    assert_eq!(config.cone_tan, default_cone_tan());
    // 对角线 = hypot(2,2,2)(dims 5 × cellSize 0.5 → 每轴 2m)。
    let diagonal = (12.0f64).sqrt();
    assert_eq!(config.max_distance, diagonal);
    // 越上限 coneTan 回缺省;合法值透传。
    let custom = resolve_sdf_sky_visibility_trace_config(
        &grid,
        SdfSkyVisibilityTraceOptions {
            steps: Some(16),
            cone_tan: Some(0.5),
            max_distance: Some(diagonal * 2.0),
        },
    );
    assert_eq!(custom.steps, 16);
    assert_eq!(custom.cone_tan, 0.5);
    assert_eq!(custom.max_distance, diagonal * 2.0);
}

#[test]
fn trace_is_deterministic_bitwise() {
    let grid = box_grid();
    let config =
        resolve_sdf_sky_visibility_trace_config(&grid, SdfSkyVisibilityTraceOptions::default());
    let directions: Vec<[f64; 3]> = (0..16)
        .map(|ordinal| probe_occlusion_direction(ordinal, 16))
        .collect();
    let probes = [[-0.75, 0.0, 0.0], [2.0, 2.0, 2.0], [-1.0, -1.0, -1.0]];
    let (left_vis, left_hits) =
        trace_sdf_sky_visibility_with_hits(&grid, &probes, &directions, &config);
    let (right_vis, right_hits) =
        trace_sdf_sky_visibility_with_hits(&grid, &probes, &directions, &config);
    assert_eq!(left_vis, right_vis);
    assert_eq!(left_hits, right_hits);
}

#[test]
fn sky_trace_params_layout_matches_wgsl_struct() {
    let grid = box_grid();
    let config =
        resolve_sdf_sky_visibility_trace_config(&grid, SdfSkyVisibilityTraceOptions::default());
    let params = SdfSkyTraceParams::from_config(&grid, &config, 16, 30);
    assert_eq!(
        size_of::<SdfSkyTraceParams>(),
        SDF_SKY_VISIBILITY_PARAMS_BYTES
    );
    assert_eq!(params.dimensions, [5, 5, 5]);
    assert_eq!(params.steps, config.steps as u32);
    assert_eq!(params.direction_count, 16);
    assert_eq!(params.probe_count, 30);
    // 方向/探针表:vec4 步长、w 恒 0。
    let table = pack_direction_table(&[[1.0, 0.0, 0.0]]);
    assert_eq!(table, vec![1.0, 0.0, 0.0, 0.0]);
    let positions = pack_probe_positions(&[[1.0, 2.0, 3.0]]);
    assert_eq!(positions, vec![1.0, 2.0, 3.0, 0.0]);
}
