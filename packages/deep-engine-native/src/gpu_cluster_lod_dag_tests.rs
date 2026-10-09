//! 簇 LOD DAG 运行时构建测试(批 C):金样 `.dgc` 字节端到端 + 合同反例注入。
//!
//! 金样字节 = `geometry_dag/tests/fixtures/quick_sphere.dgc.golden.json`
//! (dgc_byte_golden 门的入库字节,SHA-256 夹具自洽):构建 → 合同签核 →
//! 选层(批 A 权威)→ indirect 计划(批 B 镜像)全链绿;反例注入证明门咬人。

use crate::gpu_cluster_lod_dag::{
    CLUSTER_LOD_MAX_NODES, ClusterLodDagRuntime, ClusterLodDagRuntimeError,
    validate_cluster_lod_runtime_dag,
};
use crate::gpu_cluster_lod_indirect::{ClusterLodLevelGeometrySummary, plan_cluster_lod_indirect};
use crate::gpu_cluster_lod_selection::{
    CLUSTER_LOD_REFINE_SENTINEL, ClusterLodCamera, ClusterLodNode, select_cluster_lod,
    unpack_cluster_lod_nodes,
};
use geometry_dag::{DagOptions, DgcWriteOptions, build_meshlet_dag, parse_obj, write_dgc};

const GOLDEN_JSON: &str =
    include_str!("../geometry_dag/tests/fixtures/quick_sphere.dgc.golden.json");
const GOLDEN_OBJ: &str = include_str!("../geometry_dag/tests/fixtures/quick_sphere.obj");

/// 标准 alphabet base64 解码(测试本地零依赖;输入来自入库 fixture,损坏即 panic)。
fn decode_base64(text: &str) -> Vec<u8> {
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

pub(crate) fn golden_variant(name: &str) -> Vec<u8> {
    let json: serde_json::Value = serde_json::from_str(GOLDEN_JSON).expect("golden json parses");
    let bytes_b64 = json["variants"][name]["bytesB64"]
        .as_str()
        .unwrap_or_else(|| panic!("variant {name} bytesB64 missing"));
    let declared_count = json["variants"][name]["byteCount"]
        .as_u64()
        .expect("byteCount") as usize;
    let bytes = decode_base64(bytes_b64);
    assert_eq!(
        bytes.len(),
        declared_count,
        "variant {name} byteCount drift"
    );
    bytes
}

/// 相机:取 DAG 包围盒中心,沿 -z 注视;threshold 由用例给。
pub(crate) fn camera_for(runtime: &ClusterLodDagRuntime, pixel_threshold: f64) -> ClusterLodCamera {
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

fn structural_leaves_and_roots(nodes: &[ClusterLodNode]) -> (Vec<String>, Vec<String>) {
    let is_child: std::collections::HashSet<&str> = nodes
        .iter()
        .flat_map(|node| node.children.iter().map(String::as_str))
        .collect();
    let leaves: Vec<String> = nodes
        .iter()
        .filter(|node| node.children.is_empty())
        .map(|node| node.id.clone())
        .collect();
    let roots: Vec<String> = nodes
        .iter()
        .filter(|node| !is_child.contains(node.id.as_str()))
        .map(|node| node.id.clone())
        .collect();
    (leaves, roots)
}

#[test]
fn golden_bytes_build_valid_and_mapping_matches_independent_read() {
    for variant in ["compressed", "uncompressed"] {
        let bytes = golden_variant(variant);
        let runtime = ClusterLodDagRuntime::from_dgc(&bytes, "quick_sphere-golden")
            .unwrap_or_else(|error| panic!("{variant}: build rejected: {error}"));
        assert_eq!(runtime.geometry_id, "quick_sphere-golden");
        assert_eq!(
            runtime.level_count, 2,
            "{variant}: quick_sphere compiles 2 levels"
        );
        assert!(!runtime.nodes.is_empty(), "{variant}: nodes present");
        assert_eq!(
            runtime.node_storage.len(),
            runtime.nodes.len() * 64,
            "{variant}: 64B stride packing"
        );
        assert_eq!(
            runtime.level_summaries.len(),
            runtime.level_count,
            "{variant}: per-level summaries"
        );
        // 独立复读一路 read_dgc,逐节点核对路 4 映射源(descriptors/bounds/error)。
        let dag = geometry_dag::read_dgc(&bytes).expect("independent read");
        let mut cursor = 0usize;
        for (k, level) in dag.levels.iter().enumerate() {
            for c in 0..level.meshlet_count {
                let node = &runtime.nodes[cursor];
                cursor += 1;
                assert_eq!(node.id, format!("l{k}-c{c}"), "{variant}: node id formula");
                assert_eq!(node.level, k as u32, "{variant}: level");
                assert_eq!(
                    node.error, level.error,
                    "{variant}: level error passthrough"
                );
                assert_eq!(
                    node.first_triangle,
                    level.descriptors[c * 4 + 2],
                    "{variant}: firstTriangle = descriptors[c*4+2]"
                );
                assert_eq!(
                    node.triangle_count,
                    level.descriptors[c * 4 + 3],
                    "{variant}: triangleCount = descriptors[c*4+3]"
                );
                let base = c * 16;
                for axis in 0..3 {
                    assert_eq!(
                        node.bounds_min[axis],
                        f64::from(level.bounds[base + 4 + axis]),
                        "{variant}: boundsMin word 4..6"
                    );
                    assert_eq!(
                        node.bounds_max[axis],
                        f64::from(level.bounds[base + 8 + axis]),
                        "{variant}: boundsMax word 8..10"
                    );
                }
            }
        }
        assert_eq!(
            cursor,
            runtime.nodes.len(),
            "{variant}: all clusters mapped"
        );
        assert_eq!(
            runtime.leaf_triangle_total,
            dag.levels[0].indices.len() / 3,
            "{variant}: leafTriangleTotal formula"
        );
        // 打包存储 word 级:unpack 后与权威节点逐槽一致(cluster_index = 层内序号)。
        let serialized = unpack_cluster_lod_nodes(&runtime.node_storage).expect("unpack");
        assert_eq!(serialized.len(), runtime.nodes.len());
        let mut per_level: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
        for (node, slot) in runtime.nodes.iter().zip(&serialized) {
            let index = per_level.entry(node.level).or_insert(0);
            assert_eq!(
                slot.cluster_index, *index,
                "{variant}: cluster_index = per-level rank"
            );
            *index += 1;
            assert_eq!(slot.lod_level, node.level);
            assert_eq!(slot.first_triangle, node.first_triangle);
            assert_eq!(slot.triangle_count, node.triangle_count);
            assert_eq!(slot.error_scalar.to_bits(), (node.error as f32).to_bits());
            for axis in 0..3 {
                assert_eq!(
                    slot.min[axis].to_bits(),
                    (node.bounds_min[axis] as f32).to_bits()
                );
                assert_eq!(
                    slot.max[axis].to_bits(),
                    (node.bounds_max[axis] as f32).to_bits()
                );
            }
        }
    }
}

#[test]
fn golden_bytes_selection_and_plan_end_to_end() {
    let bytes = golden_variant("compressed");
    let runtime =
        ClusterLodDagRuntime::from_dgc(&bytes, "quick_sphere-golden").expect("golden builds");
    let (leaves, roots) = structural_leaves_and_roots(&runtime.nodes);
    assert!(!roots.is_empty() && !leaves.is_empty());

    // 细化臂:阈值取极小 → 全部未选中 → 前沿 = 全部叶簇。
    let camera = camera_for(&runtime, 1e-9);
    let selection = select_cluster_lod(&runtime.nodes, &camera).expect("CPU authority");
    assert_eq!(
        selection.frontier, leaves,
        "refine arm: frontier = all leaves"
    );
    let plan = plan_cluster_lod_indirect(
        &runtime.plan_nodes,
        &selection.selection,
        &runtime.level_summaries,
    )
    .expect("plan accepts refine-arm selection");
    assert_eq!(plan.draw_count, leaves.len());
    assert_eq!(plan.covered_leaf_clusters, leaves.len());
    assert_eq!(plan.covered_regions, roots.len());
    // 命令字与层跨度:从 level_summaries 独立重算基址比对。
    let mut first_index_base = 0usize;
    let mut base_vertex = 0usize;
    let mut spans = std::collections::HashMap::new();
    for summary in &runtime.level_summaries {
        spans.insert(spans.len(), (first_index_base, base_vertex));
        first_index_base += summary.index_count;
        base_vertex += summary.vertex_count;
    }
    for draw in &plan.draws {
        let node = &runtime.nodes[draw.node_index];
        let (index_base, vertex_base) = spans[&{ node.level as usize }];
        assert_eq!(
            draw.indirect_command,
            [
                (node.triangle_count * 3) as u32,
                1,
                (index_base + node.first_triangle as usize * 3) as u32,
                vertex_base as u32,
                0,
            ],
            "refine arm: draw-indexed-indirect command words"
        );
    }
    // 拼接缓冲规模 = 逐层摘要和。
    assert_eq!(runtime.vertex_buffer.len() / 3, base_vertex);
    assert_eq!(runtime.index_buffer.len(), first_index_base);

    // 粗化臂:阈值取极大 → 全部选中 → 前沿 = 全部根区域。
    let camera = camera_for(&runtime, 1e12);
    let selection = select_cluster_lod(&runtime.nodes, &camera).expect("CPU authority");
    assert_eq!(
        selection.frontier, roots,
        "coarse arm: frontier = all roots"
    );
    assert!(
        selection
            .selection
            .iter()
            .all(|slot| *slot != CLUSTER_LOD_REFINE_SENTINEL)
    );
    let plan = plan_cluster_lod_indirect(
        &runtime.plan_nodes,
        &selection.selection,
        &runtime.level_summaries,
    )
    .expect("plan accepts coarse-arm selection");
    assert_eq!(plan.draw_count, roots.len());
    assert_eq!(
        plan.covered_leaf_clusters,
        leaves.len(),
        "closure holds via roots"
    );
    // select.frontier 与 derive(frontier) 互验(批 B 一先例)。
    let derived = crate::gpu_cluster_lod_indirect::derive_cluster_lod_frontier(
        &runtime.plan_nodes,
        &selection.selection,
    )
    .expect("derive");
    let derived_ids: Vec<String> = derived
        .iter()
        .map(|index| runtime.plan_nodes[*index].id.clone())
        .collect();
    assert_eq!(derived_ids, selection.frontier);
}

#[test]
fn toolchain_round_trip_obj_build_write_read_builds() {
    // 独立臂:obj → build → write(压缩)→ from_dgc,不依赖入库 JSON 字节。
    let geometry = parse_obj(GOLDEN_OBJ).expect("obj parses");
    let dag = build_meshlet_dag(
        &geometry,
        &DagOptions {
            levels: Some(2),
            ..Default::default()
        },
    )
    .expect("golden obj builds");
    let bytes = write_dgc(&dag, &DgcWriteOptions { compress: true }).expect("write");
    let runtime =
        ClusterLodDagRuntime::from_dgc(&bytes, "quick_sphere-roundtrip").expect("roundtrip builds");
    assert_eq!(runtime.level_count, dag.levels.len());
    let total_clusters: usize = dag.levels.iter().map(|l| l.meshlet_count).sum();
    assert_eq!(runtime.nodes.len(), total_clusters);
    assert_eq!(runtime.leaf_triangle_total, dag.levels[0].indices.len() / 3);
    // 与 golden 字节臂同构:节点表打包、计划面均可零转换消费。
    let camera = camera_for(&runtime, 1e12);
    let selection = select_cluster_lod(&runtime.nodes, &camera).expect("select");
    plan_cluster_lod_indirect(
        &runtime.plan_nodes,
        &selection.selection,
        &runtime.level_summaries,
    )
    .expect("plan");
}

// ---- 反例注入(合同门咬人;离线 cluster_lod_contract 反例族的运行时镜像) ----

fn two_level_nodes() -> Vec<ClusterLodNode> {
    vec![
        ClusterLodNode {
            id: "l1-c0".into(),
            level: 1,
            error: 2.0,
            bounds_min: [0.0; 3],
            bounds_max: [2.0; 3],
            first_triangle: 0,
            triangle_count: 4,
            children: vec!["l0-c0".into(), "l0-c1".into()],
        },
        ClusterLodNode {
            id: "l0-c0".into(),
            level: 0,
            error: 0.5,
            bounds_min: [0.0; 3],
            bounds_max: [1.0, 2.0, 2.0],
            first_triangle: 0,
            triangle_count: 2,
            children: vec![],
        },
        ClusterLodNode {
            id: "l0-c1".into(),
            level: 0,
            error: 0.5,
            bounds_min: [1.0, 0.0, 0.0],
            bounds_max: [2.0; 3],
            first_triangle: 2,
            triangle_count: 2,
            children: vec![],
        },
    ]
}

#[test]
fn empty_dag_rejected() {
    assert_eq!(
        validate_cluster_lod_runtime_dag(&[], 0),
        Err(ClusterLodDagRuntimeError::EmptyDag)
    );
}

#[test]
fn budget_exceeded_rejected() {
    let nodes: Vec<ClusterLodNode> = (0..=CLUSTER_LOD_MAX_NODES)
        .map(|index| ClusterLodNode {
            id: format!("l0-c{index}"),
            level: 0,
            error: 0.0,
            bounds_min: [0.0; 3],
            bounds_max: [0.0; 3],
            first_triangle: 0,
            triangle_count: 0,
            children: vec![],
        })
        .collect();
    assert!(matches!(
        validate_cluster_lod_runtime_dag(&nodes, 0),
        Err(ClusterLodDagRuntimeError::NodeBudgetExceeded { .. })
    ));
}

#[test]
fn duplicate_id_rejected() {
    let mut nodes = two_level_nodes();
    nodes[2].id = nodes[1].id.clone();
    assert_eq!(
        validate_cluster_lod_runtime_dag(&nodes, 4),
        Err(ClusterLodDagRuntimeError::DuplicateNodeId)
    );
}

#[test]
fn unknown_child_rejected() {
    let mut nodes = two_level_nodes();
    nodes[0].children.push("l0-c9".into());
    assert!(matches!(
        validate_cluster_lod_runtime_dag(&nodes, 4),
        Err(ClusterLodDagRuntimeError::UnknownChild { .. })
    ));
}

#[test]
fn child_not_refining_rejected() {
    let mut nodes = two_level_nodes();
    nodes[2].level = 1;
    assert!(matches!(
        validate_cluster_lod_runtime_dag(&nodes, 4),
        Err(ClusterLodDagRuntimeError::ChildNotRefining { .. })
    ));
}

#[test]
fn children_at_leaf_level_rejected() {
    let mut nodes = two_level_nodes();
    nodes[0].level = 0;
    assert!(matches!(
        validate_cluster_lod_runtime_dag(&nodes, 4),
        Err(ClusterLodDagRuntimeError::ChildrenAtLeafLevel { .. })
    ));
}

#[test]
fn inverted_bounds_rejected() {
    let mut nodes = two_level_nodes();
    nodes[1].bounds_max[1] = nodes[1].bounds_min[1] - 1.0;
    assert!(matches!(
        validate_cluster_lod_runtime_dag(&nodes, 4),
        Err(ClusterLodDagRuntimeError::InvertedBounds { .. })
    ));
}

#[test]
fn error_monotonicity_rejected() {
    let mut nodes = two_level_nodes();
    nodes[0].error = nodes[1].error; // 父层误差不再严格大于叶层
    assert!(matches!(
        validate_cluster_lod_runtime_dag(&nodes, 4),
        Err(ClusterLodDagRuntimeError::ErrorNotStrictlyIncreasing { .. })
    ));
}

#[test]
fn coverage_gap_rejected() {
    // 叶区间真缺口:叶2 只覆盖 [2,3) → 去重并集 = 3 ≠ 声明 4 → 覆盖闭合破坏。
    // (孤儿叶不构成缺口:非任何节点的 child 按根访问,孤儿覆盖裁决口径。)
    let mut nodes = two_level_nodes();
    nodes[2].triangle_count = 1;
    assert!(matches!(
        validate_cluster_lod_runtime_dag(&nodes, 4),
        Err(ClusterLodDagRuntimeError::LeafCoverageMismatch {
            covered: 3,
            declared: 4
        })
    ));
}

#[test]
fn orphan_leaf_counted_as_extra_leaf_not_gap() {
    // 根不可达且无自身三角形的簇 = 纯孤儿 → 按根访问,其子叶计入并集 → 覆盖闭合不破。
    // (若保留粗簇自身三角形,脱挂后粗簇自成叶,逐层求和 4+4=8 ≠ 4,如语义所拒。)
    let mut nodes = two_level_nodes();
    nodes[0].children.clear();
    nodes[0].triangle_count = 0;
    validate_cluster_lod_runtime_dag(&nodes, 4).expect("orphan leaves still cover all 4");
}

#[test]
fn overlapping_leaf_intervals_deduped_not_double_counted() {
    // 同层叶区间重叠:[1,3) 与 [2,4) 去重并集 = [1,4) = 3。
    // 若按逐叶求和会得 4 ≠ 3 → 红灯,证明去重生效(重叠凑数绕不过覆盖闭合)。
    let mut nodes = two_level_nodes();
    nodes[1].first_triangle = 1;
    assert_eq!(nodes[2].first_triangle, 2);
    validate_cluster_lod_runtime_dag(&nodes, 3).expect("overlapping union covers 3, deduped");
}

#[test]
fn geometry_id_required() {
    let bytes = golden_variant("compressed");
    assert_eq!(
        ClusterLodDagRuntime::from_dgc(&bytes, "").unwrap_err(),
        ClusterLodDagRuntimeError::GeometryIdRequired
    );
}

#[test]
fn truncated_bytes_fail_closed_with_parse_reason() {
    let bytes = golden_variant("compressed");
    assert!(matches!(
        ClusterLodDagRuntime::from_dgc(&bytes[..40], "quick_sphere"),
        Err(ClusterLodDagRuntimeError::DgcParse(_))
    ));
}

#[test]
fn level_summary_guard_surfaces_through_plan() {
    // 摘要层数不足 → 计划侧 fail-closed(运行时产物直接喂计划,错误面可观察)。
    let bytes = golden_variant("compressed");
    let runtime = ClusterLodDagRuntime::from_dgc(&bytes, "quick_sphere-golden").expect("builds");
    let camera = camera_for(&runtime, 1e12);
    let selection = select_cluster_lod(&runtime.nodes, &camera).expect("select");
    let summaries = vec![ClusterLodLevelGeometrySummary {
        vertex_count: 1,
        index_count: 3,
    }];
    assert!(
        plan_cluster_lod_indirect(&runtime.plan_nodes, &selection.selection, &summaries).is_err()
    );
}

/// Display 稳定性:错误面文案与 TS 理由同语义(词级断言,防漂移)。
#[test]
fn cluster_lod_dag_error_display_is_stable() {
    assert_eq!(
        ClusterLodDagRuntimeError::GeometryIdRequired.to_string(),
        "DAG geometry id is required."
    );
    assert_eq!(
        ClusterLodDagRuntimeError::EmptyDag.to_string(),
        "DAG must contain at least one node."
    );
    assert_eq!(
        ClusterLodDagRuntimeError::NodeBudgetExceeded { nodes: 5 }.to_string(),
        format!("DAG node budget exceeded (5 > {CLUSTER_LOD_MAX_NODES}).")
    );
    assert_eq!(
        ClusterLodDagRuntimeError::LeafCoverageMismatch {
            covered: 2,
            declared: 4
        }
        .to_string(),
        "DAG leaves cover 2 triangles but the geometry declares 4."
    );
    assert_eq!(
        ClusterLodDagRuntimeError::ChildrenAtLeafLevel {
            node: "l0-c0".into()
        }
        .to_string(),
        "Node l0-c0 has children at the leaf level."
    );
}
