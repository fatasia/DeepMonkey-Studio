//! sdf-gi GPU 链的 CPU 面单测(内容哈希确定性/三角形展平域公式/参数 α 语义;
//! 真机腿在 sdf_gi_gpu_probe_tests)。经 #[path] 挂在 [`super`]。

use super::*;
use deep_engine_native::sdf_gi_scene::SdfSceneTransform;

fn unit_source(id: &str, offset: f32) -> SdfGiBakeSource {
    let corners: [[f32; 3]; 8] = [
        [-1.0, -1.0, -1.0],
        [1.0, -1.0, -1.0],
        [1.0, 1.0, -1.0],
        [-1.0, 1.0, -1.0],
        [-1.0, -1.0, 1.0],
        [1.0, -1.0, 1.0],
        [1.0, 1.0, 1.0],
        [-1.0, 1.0, 1.0],
    ];
    let mut positions = Vec::new();
    for corner in &corners {
        positions.extend_from_slice(corner);
    }
    SdfGiBakeSource {
        id: id.into(),
        positions: std::sync::Arc::new(positions),
        indices: vec![
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 4, 7, 3, 4, 3, 0, 1, 2, 6, 1, 6, 5, 3, 7, 6, 3, 6,
            2, 4, 0, 1, 4, 1, 5,
        ],
        transform: SdfSceneTransform {
            translation: [f64::from(offset), 0.0, 0.0],
            ..SdfSceneTransform::default()
        },
    }
}

#[test]
fn bake_content_hash_is_deterministic_and_content_sensitive() {
    let base = vec![unit_source("a", 0.0), unit_source("b", 3.0)];
    let hash = sdf_gi_bake_content_hash(&base, 0.25);
    assert_eq!(
        sdf_gi_bake_content_hash(&base, 0.25),
        hash,
        "同输入逐位同哈希(无 RNG)"
    );
    // id 变 → 变;顶点变(平移)→ 变;实例序换 → 变;cellSize 变 → 变。
    let renamed = vec![unit_source("a2", 0.0), unit_source("b", 3.0)];
    assert_ne!(sdf_gi_bake_content_hash(&renamed, 0.25), hash);
    let moved = vec![unit_source("a", 0.5), unit_source("b", 3.0)];
    assert_ne!(sdf_gi_bake_content_hash(&moved, 0.25), hash);
    let swapped = vec![unit_source("b", 3.0), unit_source("a", 0.0)];
    assert_ne!(sdf_gi_bake_content_hash(&swapped, 0.25), hash);
    assert_ne!(sdf_gi_bake_content_hash(&base, 0.5), hash);
}

#[test]
fn flatten_domain_matches_cpu_instance_grid_formula() {
    use deep_engine_native::sdf_gi_scene::{
        SdfInstanceDomain, SdfSceneBakeInstance, bake_instance_grid, transformed_triangle_bounds,
    };
    use deep_engine_native::sdf_gi_scene_compose::SdfSceneBakeOptions;
    let sources = vec![unit_source("a", 0.0)];
    // 经 plan_sdf_scene_grid 走真实规划面(单一实现点)。
    let bake_instances: Vec<SdfSceneBakeInstance<'_>> = sources
        .iter()
        .map(|source| SdfSceneBakeInstance {
            id: &source.id,
            positions: source.positions.as_slice(),
            indices: &source.indices,
            dynamic: false,
            transform: Some(source.transform.clone()),
        })
        .collect();
    let cell = deep_engine_native::sdf_gi_scene_compose::resolve_sdf_gi_bake_cell_size(
        &bake_instances,
        None,
    );
    let grid_plan = deep_engine_native::sdf_gi_scene_compose::plan_sdf_scene_grid(
        &bake_instances,
        SdfSceneBakeOptions {
            cell_size: cell,
            instance_domain: SdfInstanceDomain::Aabb,
            ..SdfSceneBakeOptions::default()
        },
    )
    .expect("unit scene must plan");
    let plan_view = super::super::sdf_gi_runtime::SdfGiGpuPlan {
        cell_size: cell,
        grid_plan,
        lattice: deep_engine_native::sdf_gi_scene_compose::SdfGiProbeLattice {
            positions: Vec::new(),
            dimensions: [2, 2, 2],
            spacing: 1.0,
        },
        directions: Vec::new(),
        sky_radiance: Vec::new(),
        trace_config: deep_engine_native::sdf_gi_trace::SdfSkyVisibilityTraceConfig {
            steps: 8,
            cone_tan: 0.1,
            max_distance: 1.0,
        },
        content_hash: [0; 32],
    };
    let triangles = flatten_world_triangles(&sources, &plan_view);
    assert_eq!(triangles.len(), 12 * 20, "12 三角形 × 5 vec4");
    // 域公式对拍:flatten 的域 origin/dims 与 CPU bake_instance_grid 逐值一致。
    let (bounds_min, bounds_max) = transformed_triangle_bounds(
        &sources[0].positions,
        &sources[0].indices,
        Some(&sources[0].transform),
    );
    bake_instance_grid(
        &sources[0].positions,
        &sources[0].indices,
        Some(&sources[0].transform),
        bounds_min,
        bounds_max,
        cell,
        plan_view.grid_plan.dimensions,
        plan_view.grid_plan.scene_min,
        SdfInstanceDomain::Aabb,
    )
    .expect("unit instance must bake");
    let pad = cell;
    let origin: [f32; 3] = std::array::from_fn(|axis| (bounds_min[axis] - pad) as f32);
    let dims: [usize; 3] = std::array::from_fn(|axis| {
        (((bounds_max[axis] + pad - f64::from(origin[axis])) / cell).ceil() + 1.0) as usize
    });
    // 首三角形第 4/5 vec4 = (origin, dimX)/(dimY, dimZ)(20 floats 中 12..20)。
    let first = &triangles[12..20];
    assert_eq!(
        &first[..4],
        &[origin[0], origin[1], origin[2], dims[0] as f32]
    );
    assert_eq!(&first[4..8], &[dims[1] as f32, dims[2] as f32, 0.0, 0.0]);
}

#[test]
fn update_params_alpha_discriminates_first_trace_from_window() {
    let plan_probe_count = 7usize;
    let first = update_params_struct(plan_probe_count, 16, 0, 7, 10.0, 1.0);
    assert_eq!(first.alpha, 1.0, "全域首追 α=1(首帧语义与 CPU 腿一致)");
    let window = update_params_struct(
        plan_probe_count,
        16,
        7,
        7,
        10.0,
        DEEP_GI_PROBE_TEMPORAL_ALPHA,
    );
    assert!((window.alpha - 0.1).abs() < 1e-6, "帧窗口用缺省时域滤波 α");
    assert_eq!(window.window_offset, 7);
    assert_eq!(window.window_count, 7);
    assert_eq!(first.record_vec4_stride, 6);
}
