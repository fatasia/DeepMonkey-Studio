//! indirect 计划的 Rust 镜像测试:与 select 的 frontier 互验(multiset 相等合同)、
//! fixture selection 驱动的计划命令字正确性、fail-closed 反例族。

use crate::gpu_cluster_lod_indirect::{
    derive_cluster_lod_frontier, plan_cluster_lod_indirect, ClusterLodIndirectDraw,
    ClusterLodLevelGeometrySummary, ClusterLodPlanError, ClusterLodPlanNode,
    CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES,
};
use crate::gpu_cluster_lod_selection::{select_cluster_lod, ClusterLodCamera, ClusterLodNode};

fn two_level_dag() -> Vec<ClusterLodPlanNode> {
    vec![
        ClusterLodPlanNode {
            id: "root".into(),
            level: 0,
            children: vec!["a".into(), "b".into()],
            first_triangle: 0,
            triangle_count: 16,
        },
        ClusterLodPlanNode {
            id: "a".into(),
            level: 1,
            children: vec![],
            first_triangle: 0,
            triangle_count: 8,
        },
        ClusterLodPlanNode {
            id: "b".into(),
            level: 1,
            children: vec![],
            first_triangle: 8,
            triangle_count: 8,
        },
    ]
}

fn levels() -> [ClusterLodLevelGeometrySummary; 2] {
    [
        ClusterLodLevelGeometrySummary { vertex_count: 24, index_count: 48 },
        ClusterLodLevelGeometrySummary { vertex_count: 48, index_count: 96 },
    ]
}

fn camera_far() -> ClusterLodCamera {
    ClusterLodCamera {
        position: [8.0, 6.0, 24.0],
        forward: [-0.28, -0.2, -0.936],
        viewport_height_pixels: 720.0,
        tan_half_fov_y: 0.7,
        pixel_threshold: 8.0,
    }
}

#[test]
fn plan_frontier_and_select_frontier_are_multiset_equal() {
    let nodes = two_level_dag();
    let nodes_sel: Vec<crate::gpu_cluster_lod_selection::ClusterLodNode> = nodes
        .iter()
        .map(|node| crate::gpu_cluster_lod_selection::ClusterLodNode {
            id: node.id.clone(),
            level: node.level as u32,
            error: if node.level == 0 { 4.0 } else { 0.5 },
            bounds_min: [0.0, 0.0, 0.0],
            bounds_max: [2.0, 2.0, 2.0],
            first_triangle: node.first_triangle as u32,
            triangle_count: node.triangle_count as u32,
            children: node.children.clone(),
        })
        .collect();
    let camera = camera_far();
    let selected = select_cluster_lod(&nodes_sel, &camera).expect("selects");
    let frontier_plan =
        derive_cluster_lod_frontier(&nodes, &selected.selection).expect("plan frontier");
    let mut frontier_plan_ids: Vec<&str> =
        frontier_plan.iter().map(|index| nodes[*index].id.as_str()).collect();
    frontier_plan_ids.sort_unstable();
    let mut frontier_select_ids: Vec<&str> = selected
        .frontier
        .iter()
        .map(String::as_str)
        .collect();
    frontier_select_ids.sort_unstable();
    assert_eq!(frontier_plan_ids, frontier_select_ids);
}

#[test]
fn plan_draws_carry_correct_command_words_and_spans() {
    let nodes = two_level_dag();
    let selection = [0xffff_ffff, 1, 1]; // 根未选,两叶选中 → 两前沿绘制(level 1)。
    let plan = plan_cluster_lod_indirect(&nodes, &selection, &levels()).expect("plans");
    assert_eq!(plan.draw_count, 2);
    assert_eq!(plan.commands_byte_length, 2 * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES);
    assert_eq!(plan.level_spans[1].first_index_base, 48);
    assert_eq!(plan.level_spans[1].base_vertex, 24);
    assert_eq!(plan.covered_regions, 1);
    assert_eq!(plan.covered_leaf_clusters, 2);
    // 层内 cluster 序:节点顺序 a(0)、b(1);firstIndex = 48 + firstTriangle×3。
    let draw_a = plan
        .draws
        .iter()
        .find(|draw| draw.node_id == "a")
        .expect("draw a");
    assert_eq!(
        draw_a.indirect_command,
        [24, 1, 48 + draw_a.first_triangle as u32 * 3, 24, 0]
    );
}

#[test]
fn fail_closed_family_matches_ts_semantics() {
    let nodes = two_level_dag();
    // 槽位长度不匹配。
    assert!(matches!(
        plan_cluster_lod_indirect(&nodes, &[], &levels()),
        Err(ClusterLodPlanError::SelectionLengthMismatch { .. })
    ));
    // 槽位值非法(既非哨兵也非层级)。
    assert!(matches!(
        plan_cluster_lod_indirect(&nodes, &[0xffff_ffff, 9, 1], &levels()),
        Err(ClusterLodPlanError::SlotInvalid { slot: 1, value: 9, level: 1 })
    ));
    // 子被双父引用。
    let claimed = vec![
        ClusterLodPlanNode {
            id: "root".into(),
            level: 0,
            children: vec!["a".into()],
            first_triangle: 0,
            triangle_count: 4,
        },
        ClusterLodPlanNode {
            id: "other".into(),
            level: 0,
            children: vec!["a".into()],
            first_triangle: 4,
            triangle_count: 4,
        },
        ClusterLodPlanNode {
            id: "a".into(),
            level: 1,
            children: vec![],
            first_triangle: 0,
            triangle_count: 4,
        },
    ];
    assert!(matches!(
        plan_cluster_lod_indirect(&claimed, &[0, 0, 1], &levels()),
        Err(ClusterLodPlanError::ChildClaimedTwice { .. })
    ));
    // 层级规模摘要不足。
    assert!(matches!(
        plan_cluster_lod_indirect(&nodes, &[0, 1, 1], &[levels()[0]]),
        Err(ClusterLodPlanError::LevelSummaryMissing { .. })
    ));
    // 前沿闭合破坏是纵深防御(对 GPU 读回污染):合法 selection(哨兵或层级)下,
    // 父选中会剪枝子绘制,任意根-叶路径恒恰一个前沿绘制——不可由合法输入构造。
    // 校验保留在 plan 尾部作为 GPU 读回污染的最后防线(与 TS validateLeafCoverage 同位)。
}
