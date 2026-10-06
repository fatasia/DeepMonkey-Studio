//! cluster LOD 消费合同验证门(native 侧产物必须可被 TS 消费链无拒收地接住)。
//!
//! TS 权威链(只读参照,不做实现复刻):
//! - `packages/deep-engine/src/geometry/dgcClusterLodBridge.ts` — 路 4 映射
//!   (`.dgc` levels/descriptors/parentsByLevel → ClusterLodNodeDescriptor + children O(n) 反转),
//!   映射后 fail-closed 调 `validateClusterLodDag`,invalid 即抛 `DgcFormatError`;
//! - `packages/deep-engine/src/rayTracing/clusterLodDag.ts` — `validateClusterLodDag`
//!   校验序:节点预算(maxBatchRays)/唯一 id → 层号与三角形域 → 子层细化方向 →
//!   根可达叶子三角形区间并集 == leafTriangleTotal;
//! - `packages/deep-engine/src/rayTracing/clusterLodSelection.ts` — 波次 GPU 选层
//!   节点表同一 maxBatchRays 预算;逐节点 error 与像素阈值唯一投影构成选层语义,
//!   故 error 逐层严格递增是消费侧正确性不变量(TS 对拍测试钉 dgc 臂上行)。
//!
//! 本门在 native 侧提前拦截「TS 加载时才炸」的产出:任何 `write_dgc` 产物经同一
//! 映射公式与合同不变量核验必须 valid;反例注入证明门会咬人。

mod common;

use base64::Engine as _;
use common::load_fixture;
use geometry_dag::{
    build_meshlet_dag, read_dgc, write_dgc, DagOptions, DgcWriteOptions, IndexedGeometry, MeshletDag,
    NO_PARENT,
};
use std::collections::{HashMap, HashSet};

/// TS `RAY_BACKEND_LIMITS.maxBatchRays`(clusterLodSelection.ts L81 / clusterLodDag.ts 节点预算)。
const MAX_BATCH_RAYS: usize = 1 << 20;

struct ContractNode {
    id: String,
    level: usize,
    error: f64,
    first_triangle: u32,
    triangle_count: u32,
    children: Vec<String>,
    bounds_min: [f32; 3],
    bounds_max: [f32; 3],
}

struct ContractDag {
    nodes: Vec<ContractNode>,
    leaf_triangle_total: usize,
}

/// 路 4 映射镜像(与 dgcClusterLodBridge::dgcDagToClusterLod 同公式)。
///
/// 映射层结构性违规(零层/parents 表长度/父索引越界)返回 Err——
/// 对应 TS 桥的 `DgcFormatError`(其中父索引越界另由 `read_dgc` 解析链先拦)。
fn map_dag_to_cluster_lod(dag: &MeshletDag) -> Result<ContractDag, String> {
    if dag.levels.is_empty() {
        return Err("zero levels".into());
    }
    if dag.parents_by_level.len() != dag.levels.len() - 1 {
        return Err(format!(
            "{} parent tables for {} levels, expected levels-1",
            dag.parents_by_level.len(),
            dag.levels.len()
        ));
    }
    // childrenByLevel[k][p] = 引用粗层 k+1 簇 p 的细层 k 簇列表(父子表 O(n) 反转)。
    let mut children_by_level: Vec<Vec<Vec<usize>>> = Vec::with_capacity(dag.parents_by_level.len());
    for (k, parents) in dag.parents_by_level.iter().enumerate() {
        let fine_count = dag.levels[k].meshlet_count;
        if parents.len() != fine_count {
            return Err(format!(
                "parent table {k} has {} entries, fine level has {fine_count} clusters",
                parents.len()
            ));
        }
        let coarse_count = dag.levels[k + 1].meshlet_count;
        let mut children = vec![Vec::new(); coarse_count];
        for (c, &parent) in parents.iter().enumerate() {
            if parent != NO_PARENT {
                if parent as usize >= coarse_count {
                    return Err(format!("parent {parent} out of range for coarse level {}", k + 1));
                }
                children[parent as usize].push(c);
            }
        }
        children_by_level.push(children);
    }

    let mut nodes = Vec::new();
    for (k, level) in dag.levels.iter().enumerate() {
        // childrenByLevel[k-1] 以本层簇号 c 为索引(k>0);叶层无子表,按 meshlet_count 遍历。
        let children_of_level: &[Vec<usize>] = if k > 0 { &children_by_level[k - 1] } else { &[] };
        for c in 0..level.meshlet_count {
            let base = c * 16;
            let children: Vec<String> = children_of_level
                .get(c)
                .map(|fine| fine.iter().map(|child| format!("l{}-c{}", k - 1, child)).collect())
                .unwrap_or_default();
            nodes.push(ContractNode {
                id: format!("l{k}-c{c}"),
                level: k,
                error: level.error,
                first_triangle: level.descriptors[c * 4 + 2],
                triangle_count: level.descriptors[c * 4 + 3],
                children,
                bounds_min: [
                    level.bounds[base + 4],
                    level.bounds[base + 5],
                    level.bounds[base + 6],
                ],
                bounds_max: [
                    level.bounds[base + 8],
                    level.bounds[base + 9],
                    level.bounds[base + 10],
                ],
            });
        }
    }
    Ok(ContractDag { leaf_triangle_total: dag.levels[0].indices.len() / 3, nodes })
}

/// `validateClusterLodDag` 合同核验镜像(校验序与不变量逐条对应,理由码为 native 措辞)。
fn validate_cluster_lod(dag: &ContractDag) -> Result<(), String> {
    if dag.nodes.is_empty() {
        return Err("DAG must contain at least one node.".into());
    }
    if dag.nodes.len() > MAX_BATCH_RAYS {
        return Err("DAG node budget exceeded.".into());
    }
    let ids: HashSet<&str> = dag.nodes.iter().map(|n| n.id.as_str()).collect();
    if ids.len() != dag.nodes.len() {
        return Err("Duplicate DAG node id.".into());
    }
    let min_level = dag.nodes.iter().map(|n| n.level).min().expect("non-empty");
    // TS 第二循环序:先「叶层不得有子」,再逐子「存在 + 细化方向」。
    for node in &dag.nodes {
        if !node.children.is_empty() && node.level <= min_level {
            return Err(format!("Node {} has children at the leaf level.", node.id));
        }
        for child in &node.children {
            let Some(child_node) = dag.nodes.iter().find(|n| &n.id == child) else {
                return Err(format!("Node {} references unknown child {child}.", node.id));
            };
            if child_node.level >= node.level {
                return Err(format!("Node {} child {child} does not refine a coarser level.", node.id));
            }
        }
        // 消费侧 sanity:包围盒退化或非有限即数据损坏(meshletBounds 保证 min ≤ max;
        // partial_cmp 为 None = NaN,同样拒绝)。
        for axis in 0..3 {
            if !matches!(
                node.bounds_min[axis].partial_cmp(&node.bounds_max[axis]),
                Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
            ) {
                return Err(format!("Node {} has inverted bounds on axis {axis}.", node.id));
            }
        }
    }
    // 统一误差域:逐层严格递增(选层阈值单调性;单层 DAG 除外)。
    let mut level_errors: Vec<(usize, f64)> =
        dag.nodes.iter().map(|n| (n.level, n.error)).collect();
    level_errors
        .sort_by(|a, b| a.0.cmp(&b.0).then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)));
    level_errors.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
    let mut per_level_min: Vec<(usize, f64)> = Vec::new();
    for (level, error) in &level_errors {
        match per_level_min.last_mut() {
            Some((last_level, last_error)) if *last_level == *level => {
                if *error < *last_error {
                    *last_error = *error;
                }
            }
            _ => per_level_min.push((*level, *error)),
        }
    }
    for pair in per_level_min.windows(2) {
        if pair[0].1 >= pair[1].1 {
            return Err(format!(
                "error must strictly increase per level ({} >= {})",
                pair[0].1, pair[1].1
            ));
        }
    }

    // 根可达叶子三角形区间并集(逐层去重)== leafTriangleTotal(孤儿=仅该层可见额外叶子)。
    let by_id: HashMap<&str, &ContractNode> =
        dag.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let is_child: HashSet<&str> =
        dag.nodes.iter().flat_map(|n| n.children.iter().map(String::as_str)).collect();
    let mut visited: HashSet<&str> = HashSet::new();
    let mut leaf_intervals_by_level: HashMap<usize, Vec<(u32, u32)>> = HashMap::new();
    for node in &dag.nodes {
        if is_child.contains(node.id.as_str()) {
            continue;
        }
        // 迭代 DFS(根 = 非任何节点的 child;NO_PARENT 孤儿按根处理)。
        let mut stack = vec![node.id.as_str()];
        while let Some(id) = stack.pop() {
            if !visited.insert(id) {
                continue;
            }
            let current = by_id.get(id).copied().expect("child id known");
            if current.children.is_empty() && current.triangle_count > 0 {
                leaf_intervals_by_level.entry(current.level).or_default().push((
                    current.first_triangle,
                    current.first_triangle + current.triangle_count,
                ));
            }
            for child in &current.children {
                stack.push(child.as_str());
            }
        }
    }
    let mut covered = 0usize;
    for (_, mut intervals) in leaf_intervals_by_level {
        intervals.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut cursor = 0u32;
        for (start, end) in intervals {
            if end <= cursor {
                continue;
            }
            covered += (end - start.max(cursor)) as usize;
            cursor = end;
        }
    }
    if covered != dag.leaf_triangle_total {
        return Err(format!(
            "DAG leaves cover {covered} triangles but the geometry declares {}.",
            dag.leaf_triangle_total
        ));
    }
    Ok(())
}

/// 端到端:构建 → 序列化(两压缩档)→ 解析 → 映射 → 合同核验全绿。
fn assert_dag_consumable(dag: &MeshletDag, label: &str) {
    for compress in [true, false] {
        let bytes =
            write_dgc(dag, &DgcWriteOptions { compress }).unwrap_or_else(|e| panic!("{label}: write: {e}"));
        let back = read_dgc(&bytes).unwrap_or_else(|e| panic!("{label}: read: {e}"));
        let mapped =
            map_dag_to_cluster_lod(&back).unwrap_or_else(|e| panic!("{label}: bridge mapping: {e}"));
        validate_cluster_lod(&mapped)
            .unwrap_or_else(|e| panic!("{label} (compress={compress}): contract rejected: {e}"));
    }
}

fn golden_dag(name: &str) -> MeshletDag {
    let fixture = load_fixture(name);
    let geometry = IndexedGeometry { positions: fixture.positions, indices: fixture.indices };
    build_meshlet_dag(
        &geometry,
        &DagOptions { levels: Some(fixture.levels_option), ..Default::default() },
    )
    .unwrap_or_else(|e| panic!("{name}: build: {e}"))
}

#[test]
fn golden_dags_satisfy_consumption_contract() {
    for name in ["quick_sphere", "synthetic50k"] {
        let dag = golden_dag(name);
        assert_dag_consumable(&dag, name);
    }
}

#[test]
fn committed_byte_golden_satisfies_consumption_contract() {
    let path = format!("{}/tests/fixtures/quick_sphere.dgc.golden.json", env!("CARGO_MANIFEST_DIR"));
    let json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}")),
    )
    .expect("json");
    let bytes = common::B64
        .decode(json["variants"]["compressed"]["bytesB64"].as_str().expect("b64"))
        .expect("b64");
    let dag = read_dgc(&bytes).expect("read committed bytes");
    let mapped = map_dag_to_cluster_lod(&dag).expect("bridge mapping");
    validate_cluster_lod(&mapped)
        .expect("committed .dgc bytes must satisfy the TS consumption contract");
}

// ---- 反例注入:门必须咬人(每例对应 validateClusterLodDag 一条拒绝理由) ----

fn corrupted_contract(mutate: impl FnOnce(&mut ContractDag)) -> String {
    let dag = golden_dag("quick_sphere");
    let mut mapped = map_dag_to_cluster_lod(&dag).expect("baseline mapping");
    mutate(&mut mapped);
    validate_cluster_lod(&mapped).expect_err("corrupted contract must be rejected")
}

#[test]
fn rejects_duplicated_leaf_intervals() {
    // 两个叶簇声明同一三角形区间 → 并集去重后覆盖缺口 → 覆盖闭合失败。
    let reason = corrupted_contract(|dag| {
        dag.nodes[1].first_triangle = dag.nodes[0].first_triangle;
        dag.nodes[1].triangle_count = dag.nodes[0].triangle_count;
    });
    assert!(reason.contains("leaves cover"), "{reason}");
}

#[test]
fn rejects_children_at_leaf_level() {
    // 叶层(最细层)节点挂子 → TS 校验序中先于细化方向被拒。
    let reason = corrupted_contract(|dag| {
        let sibling_id = dag.nodes[1].id.clone();
        dag.nodes[0].children.push(sibling_id);
    });
    assert!(reason.contains("leaf level"), "{reason}");
}

#[test]
fn rejects_child_not_refining_level() {
    // 粗层节点把 child 指回同层(不细化)。synthetic50k 粗层簇数 > 1,必有同层兄弟。
    let dag = golden_dag("synthetic50k");
    let mut mapped = map_dag_to_cluster_lod(&dag).expect("baseline mapping");
    let min_level = mapped.nodes.iter().map(|n| n.level).min().expect("non-empty");
    let (coarsest, coarsest_level) = {
        let node = mapped
            .nodes
            .iter()
            .rev()
            .find(|n| n.level > min_level && !n.children.is_empty())
            .expect("fixture lacks a coarse level to corrupt");
        (node.id.clone(), node.level)
    };
    // 同层节点才不构成「细化」;synthetic50k 粗层簇数 > 1,必有另一同层节点。
    let same_level_id = mapped
        .nodes
        .iter()
        .find(|n| n.level == coarsest_level && n.id != coarsest)
        .map(|n| n.id.clone())
        .expect("synthetic50k coarse level has multiple clusters");
    if let Some(node) = mapped.nodes.iter_mut().find(|n| n.id == coarsest) {
        node.children.push(same_level_id);
    }
    let reason = validate_cluster_lod(&mapped).expect_err("corrupted contract must be rejected");
    assert!(reason.contains("does not refine"), "{reason}");
}

#[test]
fn rejects_error_monotonicity_violation() {
    // 把 level0(叶层)全部节点 error 抬到全场最大 → 破坏选层阈值单调性
    // (层级 error 为层级标量,须整层同改才能越过 per-level min)。
    let reason = corrupted_contract(|dag| {
        let max_error = dag.nodes.iter().map(|n| n.error).fold(f64::MIN, f64::max);
        for node in dag.nodes.iter_mut().filter(|n| n.level == 0) {
            node.error = max_error;
        }
    });
    assert!(reason.contains("strictly increase"), "{reason}");
}

#[test]
fn mapping_rejects_parent_table_shape_drift() {
    let dag = golden_dag("quick_sphere");
    // parents 表长度 ≠ 细层簇数 → TS 桥 DgcFormatError 的 native 对应。
    let mut drifted = dag.clone();
    if let Some(parents) = drifted.parents_by_level.first_mut() {
        parents.pop();
    }
    assert!(map_dag_to_cluster_lod(&drifted).is_err(), "parent table drift must be rejected");
    // 零层 DAG → TS 桥「zero levels」拒绝。
    let mut empty = dag.clone();
    empty.levels.clear();
    empty.parents_by_level.clear();
    assert!(map_dag_to_cluster_lod(&empty).is_err(), "zero levels must be rejected");
}
