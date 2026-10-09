//! Cluster LOD 渲染器接线运行时 CPU 对拍(纯函数链;GPU 真机门见
//! `gpu_cluster_lod_runtime_gpu_probe`)。
//!
//! 钉住:①相机 uniform = TS `packClusterLodCamera` 词序(fail-closed 预算);
//! ②驻留预检拦截三面产物互相矛盾;③命令字节流 = 计划 draws 逐字;
//! ④golden `.dgc` 全链(粗化/细化双臂)命令字与独立重算的层跨度基址逐值一致。
//! fixture 与 `gpu_cluster_lod_dag_tests` 同源(quick_sphere 黄金字节;解码器本地
//! 复刻以保持测试模块自含,源 = 该文件 decode_base64)。

use crate::gpu_cluster_lod_dag::{CLUSTER_LOD_MAX_NODES, ClusterLodDagRuntime};
use crate::gpu_cluster_lod_indirect::{
    CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES, plan_cluster_lod_indirect,
};
use crate::gpu_cluster_lod_runtime::{
    cluster_lod_command_bytes, pack_cluster_lod_camera_uniform, validate_cluster_lod_residency,
};
use crate::gpu_cluster_lod_selection::{ClusterLodCamera, ClusterLodNode, select_cluster_lod};

const GOLDEN_JSON: &str =
    include_str!("../geometry_dag/tests/fixtures/quick_sphere.dgc.golden.json");

/// 标准 alphabet base64 解码(与 gpu_cluster_lod_dag_tests::decode_base64 同式;
/// 输入来自入库 fixture,损坏即 panic)。GPU 探针共用。
pub fn decode_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (index, &symbol) in ALPHABET.iter().enumerate() {
        table[symbol as usize] = index as u8;
    }
    let bytes: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks_exact(4) {
        let mut quad = [0u32; 4];
        let mut padding = 0usize;
        for (slot, &symbol) in chunk.iter().enumerate() {
            if symbol == b'=' {
                padding += 1;
                quad[slot] = 0;
            } else {
                let value = table[symbol as usize];
                assert!(value != 255, "invalid base64 symbol {symbol:#x}");
                quad[slot] = u32::from(value);
            }
        }
        let word = (quad[0] << 18) | (quad[1] << 12) | (quad[2] << 6) | quad[3];
        out.push((word >> 16) as u8);
        if padding < 2 {
            out.push((word >> 8) as u8);
        }
        if padding < 1 {
            out.push(word as u8);
        }
    }
    out
}

/// golden 变体字节(GPU 探针共用)。
pub fn golden_variant(name: &str) -> Vec<u8> {
    let json: serde_json::Value = serde_json::from_str(GOLDEN_JSON).expect("golden json parses");
    let bytes_b64 = json["variants"][name]["bytesB64"]
        .as_str()
        .expect("bytesB64");
    decode_base64(bytes_b64)
}

fn golden_runtime() -> ClusterLodDagRuntime {
    ClusterLodDagRuntime::from_dgc(&golden_variant("compressed"), "quick_sphere-runtime")
        .expect("golden builds")
}

/// 相机:取 DAG 包围盒中心,沿 -z 注视(threshold 由用例给;dag_tests 同式)。
/// GPU 探针共用。
pub fn camera_for(runtime: &ClusterLodDagRuntime, pixel_threshold: f64) -> ClusterLodCamera {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for node in &runtime.nodes {
        for axis in 0..3 {
            min[axis] = min[axis].min(node.bounds_min[axis]);
            max[axis] = max[axis].max(node.bounds_max[axis]);
        }
    }
    let center = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    ClusterLodCamera {
        position: [center[0], center[1], max[2] + 6.0],
        forward: [0.0, 0.0, -1.0],
        viewport_height_pixels: 1080.0,
        tan_half_fov_y: 0.5,
        pixel_threshold,
    }
}

#[test]
fn golden_residency_passes_preflight() {
    let runtime = golden_runtime();
    validate_cluster_lod_residency(&runtime).expect("golden three faces are mutually consistent");
    assert_eq!(runtime.node_storage.len(), runtime.nodes.len() * 64);
}

#[test]
fn camera_uniform_word_order_matches_ts_pack() {
    let camera = ClusterLodCamera {
        position: [1.0, 2.0, 2000.0],
        forward: [0.0, 0.0, -1.0],
        viewport_height_pixels: 1080.0,
        tan_half_fov_y: 0.5,
        pixel_threshold: 4.0,
    };
    let uniform = pack_cluster_lod_camera_uniform(&camera, 7).expect("pack camera");
    assert_eq!(uniform.len(), 48);
    let words: Vec<u32> = uniform
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    let bits = |value: f64| (value as f32).to_bits();
    assert_eq!(
        words[0..3],
        [bits(1.0), bits(2.0), bits(2000.0)],
        "camPos xyz"
    );
    assert_eq!(words[3], bits(0.5), "tanHalfFovY");
    assert_eq!(
        words[4..7],
        [bits(0.0), bits(0.0), bits(-1.0)],
        "forward xyz"
    );
    assert_eq!(words[7], bits(4.0), "pixelThreshold");
    assert_eq!(words[8], bits(1080.0), "viewportHeightPixels");
    assert_eq!(words[9], bits(7.0), "nodeCount");
    assert_eq!(words[10..12], [0, 0], "pads");
}

#[test]
fn camera_uniform_fails_closed_on_invalid_camera_and_budget() {
    let runtime = golden_runtime();
    assert!(
        !runtime.nodes.is_empty(),
        "golden fixture is non-degenerate"
    );
    let mut invalid = camera_for(&runtime, 1.0);
    invalid.forward = [0.0, 0.0, 0.0];
    assert!(
        pack_cluster_lod_camera_uniform(&invalid, 1).is_err(),
        "zero forward rejected"
    );
    assert!(
        pack_cluster_lod_camera_uniform(&camera_for(&runtime, 1.0), CLUSTER_LOD_MAX_NODES + 1)
            .is_err(),
        "nodeCount over budget rejected"
    );
}

/// 三面产物互相矛盾 → 驻留预检 fail-closed(字段全 pub,直接构拟)。
#[test]
fn residency_preflight_rejects_contradictory_faces() {
    let runtime = golden_runtime();
    // 节点三角形域越界:叶引用超层 0 索引表。
    let mut nodes = runtime.nodes.clone();
    nodes[0].first_triangle = u32::MAX / 2;
    assert!(validate_cluster_lod_residency(&fabricate(&runtime, Some(nodes), None, None)).is_err());
    // 层级越出层表。
    let mut nodes = runtime.nodes.clone();
    nodes[0].level = 9;
    assert!(validate_cluster_lod_residency(&fabricate(&runtime, Some(nodes), None, None)).is_err());
    // 节点表与 storage 规模矛盾。
    assert!(validate_cluster_lod_residency(&fabricate(&runtime, None, Some(64), None)).is_err());
    // 拼接表与逐层摘要矛盾。
    assert!(validate_cluster_lod_residency(&fabricate(&runtime, None, None, Some(4))).is_err());
}

/// 构拟变异:覆盖节点表(Some)/storage 长度(Some) /拼接表追加字(None→不变)。
fn fabricate(
    runtime: &ClusterLodDagRuntime,
    nodes: Option<Vec<ClusterLodNode>>,
    storage_len: Option<usize>,
    extra_index_words: Option<usize>,
) -> ClusterLodDagRuntime {
    ClusterLodDagRuntime {
        geometry_id: runtime.geometry_id.clone(),
        nodes: nodes.unwrap_or_else(|| runtime.nodes.clone()),
        node_storage: {
            let mut storage = runtime.node_storage.clone();
            if let Some(length) = storage_len {
                storage.truncate(length);
            }
            storage
        },
        plan_nodes: runtime.plan_nodes.clone(),
        level_summaries: runtime.level_summaries.clone(),
        vertex_buffer: runtime.vertex_buffer.clone(),
        index_buffer: {
            let mut indices = runtime.index_buffer.clone();
            indices.resize(indices.len() + extra_index_words.unwrap_or(0), 0);
            indices
        },
        leaf_triangle_total: runtime.leaf_triangle_total,
        level_count: runtime.level_count,
    }
}

#[test]
fn refine_arm_command_bytes_match_plan_draws_word_for_word() {
    let runtime = golden_runtime();
    let camera = camera_for(&runtime, 1e-9);
    let selection = select_cluster_lod(&runtime.nodes, &camera).expect("CPU authority");
    let plan = plan_cluster_lod_indirect(
        &runtime.plan_nodes,
        &selection.selection,
        &runtime.level_summaries,
    )
    .expect("plan builds");
    assert!(plan.draw_count > 1, "refine arm fans out to leaves");
    let bytes = cluster_lod_command_bytes(&plan);
    assert_eq!(
        bytes.len(),
        plan.draw_count * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES
    );
    for (slot, draw) in plan.draws.iter().enumerate() {
        let base = slot * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES;
        for (word, expected) in draw.indirect_command.iter().enumerate() {
            let offset = base + word * 4;
            assert_eq!(
                u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()),
                *expected,
                "slot {slot} word {word}"
            );
        }
    }
}

/// 粗化臂:全部根区域入前沿,命令字基址与独立重算的层跨度逐值一致。
#[test]
fn coarse_arm_command_words_match_independent_span_recompute() {
    let runtime = golden_runtime();
    let camera = camera_for(&runtime, 1e12);
    let selection = select_cluster_lod(&runtime.nodes, &camera).expect("CPU authority");
    let plan = plan_cluster_lod_indirect(
        &runtime.plan_nodes,
        &selection.selection,
        &runtime.level_summaries,
    )
    .expect("plan builds");
    // 独立重算:Σ(索引/顶点摘要) 基址表。
    let mut spans = Vec::new();
    let mut first_index_base = 0usize;
    let mut base_vertex = 0usize;
    for (level, summary) in runtime.level_summaries.iter().enumerate() {
        spans.push((level, first_index_base, base_vertex));
        first_index_base += summary.index_count;
        base_vertex += summary.vertex_count;
    }
    assert_eq!(
        first_index_base,
        runtime.index_buffer.len(),
        "stitch parity"
    );
    assert_eq!(
        base_vertex * 3,
        runtime.vertex_buffer.len(),
        "stitch parity"
    );
    for draw in &plan.draws {
        let node = &runtime.nodes[draw.node_index];
        let (_, index_base, vertex_base) = spans[node.level as usize];
        assert_eq!(
            draw.indirect_command,
            [
                (node.triangle_count * 3) as u32,
                1,
                (index_base + node.first_triangle as usize * 3) as u32,
                vertex_base as u32,
                0,
            ],
            "coarse arm: root command words at span base"
        );
    }
    assert_eq!(plan.level_spans.len(), runtime.level_count);
    // 计划面与节点面同源(驻留预检之外的一致性抽验)。
    assert_eq!(runtime.plan_nodes.len(), runtime.nodes.len());
}
