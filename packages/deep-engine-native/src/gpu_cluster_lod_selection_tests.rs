//! Cluster LOD 选层 CPU 镜像的黄金对拍(TS `generateClusterLodNativeParity.mts`
//! 以生产 `selectClusterLod` 出 fixture:selection/screenErrors(f32 量化)/frontier
//! 序列/f64 中间量)。位级对拍纪律:selection u32 逐字、screen_errors f32 词逐字、
//! frontier 顺序一致;错误族(fail-closed)以枚举变体对拍。

use crate::gpu_cluster_lod_selection::{
    select_cluster_lod, unpack_cluster_lod_nodes, ClusterLodCamera, ClusterLodNode,
    CLUSTER_LOD_NODE_STRIDE_BYTES,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct ParityCamera {
    position: [f64; 3],
    forward: [f64; 3],
    #[serde(rename = "viewportHeightPixels")]
    viewport_height_pixels: f64,
    #[serde(rename = "tanHalfFovY")]
    tan_half_fov_y: f64,
    #[serde(rename = "pixelThreshold")]
    pixel_threshold: f64,
}

#[derive(Deserialize)]
struct ParityNode {
    id: String,
    level: u32,
    error: f64,
    #[serde(rename = "boundsMin")]
    bounds_min: [f64; 3],
    #[serde(rename = "boundsMax")]
    bounds_max: [f64; 3],
    #[serde(rename = "firstTriangle")]
    first_triangle: u32,
    #[serde(rename = "triangleCount")]
    triangle_count: u32,
    children: Vec<String>,
}

#[derive(Deserialize)]
struct ParityCase {
    name: String,
    camera: ParityCamera,
    nodes: Vec<ParityNode>,
    #[serde(rename = "expectedSelection")]
    expected_selection: Vec<u32>,
    #[serde(rename = "expectedScreenErrorsF32")]
    expected_screen_errors: Vec<f32>,
    #[serde(rename = "expectedFrontier")]
    expected_frontier: Vec<String>,
}

#[derive(Deserialize)]
struct ParityFixture {
    cases: Vec<ParityCase>,
}

fn camera_of(input: &ParityCamera) -> ClusterLodCamera {
    ClusterLodCamera {
        position: input.position,
        forward: input.forward,
        viewport_height_pixels: input.viewport_height_pixels,
        tan_half_fov_y: input.tan_half_fov_y,
        pixel_threshold: input.pixel_threshold,
    }
}

fn nodes_of(input: &[ParityNode]) -> Vec<ClusterLodNode> {
    input
        .iter()
        .map(|node| ClusterLodNode {
            id: node.id.clone(),
            level: node.level,
            error: node.error,
            bounds_min: node.bounds_min,
            bounds_max: node.bounds_max,
            first_triangle: node.first_triangle,
            triangle_count: node.triangle_count,
            children: node.children.clone(),
        })
        .collect()
}

#[test]
fn golden_parity_matches_ts_authority() {
    let raw = include_str!("../fixtures/cluster-lod-native-parity-v1.json");
    let fixture: ParityFixture = serde_json::from_str(raw).expect("parity fixture parses");
    assert!(fixture.cases.len() >= 3, "fixture must carry at least 3 cases");
    for case in &fixture.cases {
        let result = select_cluster_lod(&nodes_of(&case.nodes), &camera_of(&case.camera))
            .unwrap_or_else(|error| panic!("case {} must select cleanly: {error}", case.name));
        assert_eq!(
            result.selection,
            case.expected_selection,
            "case {} selection mismatch",
            case.name
        );
        assert_eq!(
            result.screen_errors,
            case.expected_screen_errors,
            "case {} screen errors must match f32-quantized TS words",
            case.name
        );
        assert_eq!(
            result.frontier,
            case.expected_frontier,
            "case {} frontier order must match TS DFS",
            case.name
        );
    }
}

#[test]
fn pack_unpack_roundtrip_is_strictly_inverse() {
    let node = ClusterLodNode {
        id: "n".into(),
        level: 2,
        error: 0.75,
        bounds_min: [-1.5, 0.25, -3.0],
        bounds_max: [2.5, 4.0, 1.0],
        first_triangle: 12,
        triangle_count: 88,
        children: vec![],
    };
    let packed = crate::gpu_cluster_lod_selection::pack_cluster_lod_node(&node, 5);
    assert_eq!(packed.len(), CLUSTER_LOD_NODE_STRIDE_BYTES);
    let unpacked = unpack_cluster_lod_nodes(&packed).expect("unpack");
    assert_eq!(unpacked.len(), 1);
    let unpacked = &unpacked[0];
    assert_eq!(unpacked.error_scalar, 0.75f32);
    assert_eq!(unpacked.lod_level, 2);
    assert_eq!(unpacked.cluster_index, 5);
    assert_eq!(unpacked.first_triangle, 12);
    assert_eq!(unpacked.triangle_count, 88);
    assert_eq!(unpacked.min, [-1.5f32, 0.25, -3.0]);
    assert_eq!(unpacked.max, [2.5f32, 4.0, 1.0]);
}

#[test]
fn frontier_covers_leaf_region_exactly_once() {
    // 根(粗,选中条件不满足→REFINE)→ 两子(都选中):frontier = 两子,根不在。
    let nodes = vec![
        ClusterLodNode {
            id: "root".into(),
            level: 0,
            error: 4.0,
            bounds_min: [0.0, 0.0, 0.0],
            bounds_max: [2.0, 2.0, 2.0],
            first_triangle: 0,
            triangle_count: 16,
            children: vec!["a".into(), "b".into()],
        },
        ClusterLodNode {
            id: "a".into(),
            level: 1,
            error: 0.5,
            bounds_min: [0.0, 0.0, 0.0],
            bounds_max: [1.0, 2.0, 2.0],
            first_triangle: 0,
            triangle_count: 8,
            children: vec![],
        },
        ClusterLodNode {
            id: "b".into(),
            level: 1,
            error: 0.5,
            bounds_min: [1.0, 0.0, 0.0],
            bounds_max: [2.0, 2.0, 2.0],
            first_triangle: 8,
            triangle_count: 8,
            children: vec![],
        },
    ];
    let camera = ClusterLodCamera {
        position: [1.0, 1.0, 10.0],
        forward: [0.0, 0.0, -1.0],
        viewport_height_pixels: 1080.0,
        tan_half_fov_y: 0.5,
        pixel_threshold: 4.0,
    };
    let result = select_cluster_lod(&nodes, &camera).expect("selects");
    assert_eq!(result.frontier, vec!["a".to_string(), "b".to_string()]);
}
