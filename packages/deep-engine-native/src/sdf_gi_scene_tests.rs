//! [`crate::sdf_gi_scene`] 单元测试:解析解(轴对齐盒)+ 排除/跳过合同 + lattice。

use super::*;

/// 单位闭盒 12 三角形(6 面各 2;CCW 外向)。
fn unit_box(tr: f64) -> (Vec<f32>, Vec<u32>) {
    let p = |x: f64, y: f64, z: f64| -> [f32; 3] {
        [(x * tr) as f32, (y * tr) as f32, (z * tr) as f32]
    };
    let v = [
        p(0.0, 0.0, 0.0),
        p(1.0, 0.0, 0.0),
        p(1.0, 1.0, 0.0),
        p(0.0, 1.0, 0.0),
        p(0.0, 0.0, 1.0),
        p(1.0, 0.0, 1.0),
        p(1.0, 1.0, 1.0),
        p(0.0, 1.0, 1.0),
    ];
    let mut positions = Vec::new();
    for corner in &v {
        positions.extend_from_slice(corner);
    }
    let indices: Vec<u32> = vec![
        2, 1, 0, 3, 2, 0, // z=0
        4, 5, 6, 4, 6, 7, // z=1
        0, 1, 5, 0, 5, 4, // y=0
        6, 2, 3, 6, 3, 7, // y=1
        1, 2, 6, 1, 6, 5, // x=1
        3, 0, 4, 3, 4, 7, // x=0
    ];
    (positions, indices)
}

fn instance<'a>(
    id: &'a str,
    positions: &'a [f32],
    indices: &'a [u32],
    transform: Option<SdfSceneTransform>,
    dynamic: bool,
) -> SdfSceneBakeInstance<'a> {
    SdfSceneBakeInstance {
        id,
        positions,
        indices,
        dynamic,
        transform,
    }
}

#[test]
fn unit_box_field_matches_analytic_distance() {
    let (positions, indices) = unit_box(1.0);
    let grid_origin = [fround(-1.0), fround(-1.0), fround(-1.0)];
    let distances = build_sdf_grid(&positions, &indices, grid_origin, 0.5, [5, 5, 5]).unwrap();
    // cell 坐标 p = -1 + 0.5·k;盒 [0,1]³。轴对齐盒的精确 SDF 在格点上可解析。
    let at = |x: usize, y: usize, z: usize| -> f32 { distances[(z * 5 + y) * 5 + x] };
    // 角点 (-1,-1,-1):距盒最近点为原点,精确距 sqrt(3)。
    assert_eq!(at(0, 0, 0), (3.0f64.sqrt()) as f32);
    // (-1, 0, 0) 即格 (0,2,2):最近表面点 (0,0,0),距 1。
    assert_eq!(at(0, 2, 2), 1.0);
    // (0,0,0) 是盒角顶点 → 距离 ±0(顶点在面上;符号退化为 ±0,数值相等)。
    assert_eq!(at(2, 2, 2), 0.0);
    // 盒心 (0.5,0.5,0.5) = 格 (3,3,3):内部 → 距表面 0.5 → −0.5。
    assert_eq!(at(3, 3, 3), -0.5);
}

#[test]
fn scene_bake_min_composes_and_reports() {
    let (a_positions, indices) = unit_box(1.0);
    let (mut b_positions, _) = unit_box(1.0);
    // 实例 B:平移 [2,0,0] → 盒 [2,3]×[0,1]×[0,1]。
    for vertex in b_positions.chunks_mut(3) {
        vertex[0] += 2.0;
    }
    let instances = [
        instance("b", &b_positions, &indices, None, false),
        instance("dyn", &a_positions, &indices, None, true),
        instance("a", &a_positions, &indices, None, false),
    ];
    let (grid, report) = bake_sdf_scene_grid(
        &instances,
        SdfSceneBakeOptions {
            cell_size: 0.5,
            ..SdfSceneBakeOptions::default()
        },
    )
    .unwrap();
    assert_eq!(report.baked_count, 2);
    assert_eq!(report.excluded_dynamic_count, 1);
    assert_eq!(report.skipped_count, 0);
    assert_eq!(report.cached_count, 0);
    // bounds = [0,1] ∪ [2,3] → min (0,0,0),max (3,1,1);dims = (7,3,3)。
    assert_eq!(grid.dimensions, [7, 3, 3]);
    assert_eq!(grid.origin, [0.0, 0.0, 0.0]);
    // bounds = [0,1]∪[2,3] → diag = hypot(3,1,1) = sqrt(11)。
    assert_eq!(report.exterior_distance as f64, fround(11.0f64.sqrt()));
    // 双盒之间的空隙:(1.5, 0.5, 0.5) = 格 (3,1,1) 距两盒均 0.5(min 合成取正 0.5)。
    let at = |x: usize, y: usize, z: usize| grid.distances[(z * 3 + y) * 7 + x];
    assert_eq!(at(3, 1, 1), 0.5);
    // 逐 id 升序报告(TS 合同)。
    let ids: Vec<&str> = report.instances.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, vec!["a", "b", "dyn"]);
}

#[test]
fn transform_scale_translation_matches_analytic() {
    let (positions, indices) = unit_box(1.0);
    // 缩放 2 + 平移 [1,0,0] → 盒 [1,3]×[0,2]×[0,2]。
    let transform = SdfSceneTransform {
        basis: [2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0],
        translation: [1.0, 0.0, 0.0],
    };
    let instances = [instance("s", &positions, &indices, Some(transform), false)];
    let (grid, report) = bake_sdf_scene_grid(
        &instances,
        SdfSceneBakeOptions {
            cell_size: 1.0,
            ..SdfSceneBakeOptions::default()
        },
    )
    .unwrap();
    assert_eq!(report.skipped_count, 0);
    // 场景 bounds = [1,3]×[0,2]×[0,2],cellSize 1 → dims (3,3,3),origin (1,0,0)。
    assert_eq!(grid.dimensions, [3, 3, 3]);
    // 盒心 (2,1,1) = 格 (z=1,y=1,x=1) → SDF = −1(距 x 向两面均 1)。
    let (z, y, x) = (1usize, 1usize, 1usize);
    let center = (z * 3 + y) * 3 + x;
    assert_eq!(grid.distances[center], -1.0);
}

#[test]
fn invalid_and_oversized_instances_fail_visible() {
    let (positions, indices) = unit_box(1.0);
    let bad_positions = [0.0, 0.0, 0.0, 1.0, f32::NAN, 0.0];
    let instances = [
        instance("bad", &bad_positions, &[0, 1, 0], None, false),
        instance("ok", &positions, &indices, None, false),
    ];
    let (_, report) = bake_sdf_scene_grid(
        &instances,
        SdfSceneBakeOptions {
            cell_size: 0.5,
            ..SdfSceneBakeOptions::default()
        },
    )
    .unwrap();
    assert_eq!(report.skipped_count, 1);
    // 报告按 id 升序:["bad"(skipped), "ok"(baked)]。
    assert_eq!(
        report.instances[0].reason.as_deref(),
        Some("invalid-geometry")
    );

    // 16385 个三角形(索引合法循环复用顶点):触三角形规模墙(而非非法几何)。
    let huge: Vec<u32> = (0..MAX_SDF_SCENE_BAKE_TRIANGLES * 3 + 3)
        .map(|i| (i % 8) as u32)
        .collect();
    // 同场景保留一个合法实例(TS 合同:全部 statics 被跳过 = NoBakeable 错误,
    // triangle-budget 报告行只在存在其他可烘焙实例时可见)。
    let instances = [
        instance("huge", &positions, &huge, None, false),
        instance("ok", &positions, &indices, None, false),
    ];
    let (_, report) = bake_sdf_scene_grid(
        &instances,
        SdfSceneBakeOptions {
            cell_size: 0.5,
            ..SdfSceneBakeOptions::default()
        },
    )
    .unwrap();
    assert_eq!(report.skipped_count, 1);
    assert_eq!(
        report.instances[0].reason.as_deref(),
        Some("triangle-budget:16384")
    );
    assert_eq!(
        report.instances[0].status,
        SdfSceneBakeInstanceStatus::Skipped
    );
    assert_eq!(
        report.instances[1].status,
        SdfSceneBakeInstanceStatus::Baked
    );
}

#[test]
fn all_statics_skipped_is_no_bakeable_error() {
    // 全部实例都超三角形预算 → TS 同款 RangeError(无可烘焙静态实例)。
    let positions = [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0,
        0.0, 1.0, 1.0, 1.0, 1.0, 1.0,
    ];
    let huge: Vec<u32> = (0..MAX_SDF_SCENE_BAKE_TRIANGLES * 3 + 3)
        .map(|i| (i % 8) as u32)
        .collect();
    let instances = [instance("huge", &positions, &huge, None, false)];
    assert_eq!(
        bake_sdf_scene_grid(
            &instances,
            SdfSceneBakeOptions {
                cell_size: 0.5,
                ..SdfSceneBakeOptions::default()
            }
        )
        .unwrap_err(),
        SdfSceneBakeError::NoBakeableInstances
    );
}

#[test]
fn no_bakeable_instances_is_an_error() {
    let positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let instances = [instance("dyn", &positions, &[0, 1, 2], None, true)];
    assert_eq!(
        bake_sdf_scene_grid(
            &instances,
            SdfSceneBakeOptions {
                cell_size: 0.5,
                ..SdfSceneBakeOptions::default()
            }
        )
        .unwrap_err(),
        SdfSceneBakeError::NoBakeableInstances
    );
}

#[test]
fn ray_x_parity_signs_the_closed_box() {
    let (positions, indices) = unit_box(1.0);
    // 盒内点 (0.5, 0.5, 0.5):+X 射线恰好穿过 x=1 面(棱除外)→ 奇交点 → 负。
    let inside = build_sdf_grid(&positions, &indices, [0.5, 0.5, 0.5], 1.0, [2, 2, 2]).unwrap();
    assert!(inside[0] < 0.0);
    // 盒外点 (2, 0, 0):偶(零)交点 → 正。
    let outside = build_sdf_grid(&positions, &indices, [2.0, 0.0, 0.0], 1.0, [2, 2, 2]).unwrap();
    assert!(outside[0] > 0.0);
}

#[test]
fn probe_lattice_insets_half_cell_and_doubles_under_budget() {
    let grid = SdfSceneGrid {
        origin: [0.0, 0.0, 0.0],
        cell_size: 0.25,
        dimensions: [21, 9, 13],
        distances: vec![1.0; 21 * 9 * 13],
    };
    let (min, max) = probe_lattice_bounds(&grid);
    assert_eq!(min, [0.125, 0.125, 0.125]);
    assert_eq!(max, [5.0 - 0.125, 2.0 - 0.125, 3.0 - 0.125]);
    let lattice = derive_sdf_gi_probe_lattice(min, max, 1.0, 4096).unwrap();
    assert_eq!(lattice.dimensions, [5, 2, 3]);
    assert_eq!(lattice.positions.len(), 30);
    assert_eq!(lattice.positions[0], [0.125, 0.125, 0.125]);
    // 预算收紧 → spacing 确定性倍增(每轴最少 2 探针 → 预算 8 时 ×2 两档)。
    let tight = derive_sdf_gi_probe_lattice(min, max, 1.0, 8).unwrap();
    assert_eq!(tight.spacing, 4.0);
    assert_eq!(tight.dimensions, [2, 2, 2]);
    // 每轴最少 2 探针 → 预算 < 8 恒不可满足,fail-visible。
    assert!(derive_sdf_gi_probe_lattice(min, max, 1.0, 4).is_err());
}

#[test]
fn bake_cell_size_resolves_from_extent_with_clamp() {
    let (positions, indices) = unit_box(1.0);
    let instances = [instance("a", &positions, &indices, None, false)];
    // 无显式值:extent 1 / 64 = 0.015625 → 钳下界 0.05。
    assert_eq!(resolve_sdf_gi_bake_cell_size(&instances, None), 0.05);
    // 显式值越界被钳。
    assert_eq!(resolve_sdf_gi_bake_cell_size(&instances, Some(99.0)), 1.0);
    // 大实例:extent 128 → 128/64 = 2 → 钳上界 1。
    let (big, _) = unit_box(128.0);
    let big_instances = [instance("a", &big, &indices, None, false)];
    assert_eq!(resolve_sdf_gi_bake_cell_size(&big_instances, None), 1.0);
}

#[test]
fn scene_domain_bake_covers_whole_grid() {
    let (a_positions, indices) = unit_box(1.0);
    let instances = [instance("a", &a_positions, &indices, None, false)];
    let (grid, report) = bake_sdf_scene_grid(
        &instances,
        SdfSceneBakeOptions {
            cell_size: 0.5,
            instance_domain: SdfInstanceDomain::Scene,
            ..SdfSceneBakeOptions::default()
        },
    )
    .unwrap();
    assert_eq!(report.baked_count, 1);
    assert_eq!(
        report.instances[0].status,
        SdfSceneBakeInstanceStatus::Baked
    );
    // scene 域:逐资产网格 = 场景网格(全覆盖,无未覆盖空域)。
    assert!(grid.distances.iter().all(|value| value.is_finite()));
}
