//! `.dgc` 字节 → native 簇 LOD DAG 运行时构建(批 C;TS
//! `geometry/dgcClusterLodBridge.dgcDagToClusterLod` 路 4 映射 +
//! `rayTracing/clusterLodDag.validateClusterLodDag` 合同签核的 native 运行时镜像)。
//!
//! == 读取单源 ==
//! `.dgc` 解析唯一走 `geometry_dag::read_dgc`(离线工具链 crate 的权威读取器:
//! magic/版本/尺寸锁/保留字段/逐段 CRC32C/zlib 全校验),与 TS `decodeDgc`
//! 跨工具链 sha256 钉版同源(dgc_byte_golden 门)。本模块只做映射+签核,不复刻解析。
//!
//! == 路 4 映射公式(与 dgcClusterLodBridge 逐式同构,O(n)) ==
//!   levels[k] 簇 c → 节点 { firstTriangle: descriptors[c*4+2], triangleCount: descriptors[c*4+3],
//!                          error: levels[k].error }
//!   boundsMin/Max  ← bounds 的 16 f32 布局 word 4..6(aabbMin)/ 8..10(aabbMax)
//!                    (sphere(4)+aabbMin(4)+aabbMax(4)+cone(4))
//!   children       ← parentsByLevel[k] 的 O(n) 反转(粗层簇 p 的 children =
//!                    { 细层 k 簇 c : parentsByLevel[k][c] === p };NO_PARENT 孤儿原样保留)
//!   leafTriangleTotal = levels[0].indices.len()/3
//!
//! == 产物三面(供批 A/B 已入库模块零转换消费) ==
//!   selection 面:`nodes`(GPU 选层 CPU 权威输入)+ `node_storage`(64B stride GPU 节点表)
//!   indirect 面:`plan_nodes` + `level_summaries` + 拼接 `vertex_buffer`/`index_buffer`
//!   GPU 面:node_storage 直入 compute storage(gpu_cluster_lod_gpu 管线)
//!
//! == fail-closed ==
//! geometryId 缺失 / 零层 / 父表数 ≠ 层数-1 / 节点预算(maxBatchRays)/ 重复 id /
//! 叶层挂子 / 未知子 / 子不细化 / 包围盒倒置 / 逐层误差不严格递增 / 叶覆盖闭合破坏
//! 一律 [`ClusterLodDagRuntimeError`],绝不带病输出。
//! 误差单调与包围盒 sanity 是 TS 合同之外的本端消费前置(离线
//! cluster_lod_contract 门同族措辞):选层 fail-closed 依赖它们,构建期提前拦截。

use geometry_dag::{MeshletDag, NO_PARENT, read_dgc};

use crate::gpu_cluster_lod_indirect::{ClusterLodLevelGeometrySummary, ClusterLodPlanNode};
use crate::gpu_cluster_lod_selection::{
    CLUSTER_LOD_NODE_STRIDE_BYTES, ClusterLodNode, pack_cluster_lod_node,
};

/// TS `RAY_BACKEND_LIMITS.maxBatchRays`(clusterLodDag.ts 节点预算同源)。
pub const CLUSTER_LOD_MAX_NODES: usize = 1 << 20;

/// `.dgc` 构建的簇 LOD DAG 运行时(三面产物,见模块头)。
#[derive(Debug)]
pub struct ClusterLodDagRuntime {
    pub geometry_id: String,
    /// 选层面:权威节点序(level 升序,层内簇号升序;与 TS 桥 nodes 序一致)。
    pub nodes: Vec<ClusterLodNode>,
    /// GPU 节点表:64B stride × nodes.len();cluster_index 槽 = 层内序号
    /// (与 indirect 计划的 per-level 计数同式)。
    pub node_storage: Vec<u8>,
    /// indirect 面:计划输入节点。
    pub plan_nodes: Vec<ClusterLodPlanNode>,
    /// 每层几何摘要(顶点/索引计数;level 升序)。
    pub level_summaries: Vec<ClusterLodLevelGeometrySummary>,
    /// 逐层拼接顶点位置(紧凑 XYZ;spans 基址 = plan_cluster_lod_indirect 产出)。
    pub vertex_buffer: Vec<f32>,
    /// 逐层拼接索引(与 vertex_buffer 同基址域)。
    pub index_buffer: Vec<u32>,
    /// 叶子层三角形总数(levels[0].indices/3;合同覆盖闭合的声明值)。
    pub leaf_triangle_total: usize,
    pub level_count: usize,
}

/// fail-closed 错误族(TS DgcFormatError/validateClusterLodDag 理由同语义;
/// 与离线 cluster_lod_contract 门同族措辞)。
#[derive(Clone, Debug, PartialEq)]
pub enum ClusterLodDagRuntimeError {
    GeometryIdRequired,
    /// read_dgc 解析链失败(透传 geometry_dag 理由;magic/CRC/尺寸锁等)。
    DgcParse(String),
    ZeroLevels,
    ParentTableCountMismatch {
        tables: usize,
        levels: usize,
    },
    ParentOutOfRange {
        parent: u32,
        coarse_level: usize,
    },
    EmptyDag,
    NodeBudgetExceeded {
        nodes: usize,
    },
    DuplicateNodeId,
    ChildrenAtLeafLevel {
        node: String,
    },
    UnknownChild {
        parent: String,
        child: String,
    },
    ChildNotRefining {
        parent: String,
        child: String,
    },
    InvertedBounds {
        node: String,
        axis: usize,
    },
    ErrorNotStrictlyIncreasing {
        coarse: usize,
        fine: usize,
    },
    LeafCoverageMismatch {
        covered: usize,
        declared: usize,
    },
}

impl core::fmt::Display for ClusterLodDagRuntimeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::GeometryIdRequired => write!(f, "DAG geometry id is required."),
            Self::DgcParse(reason) => write!(f, "dgc parse: {reason}"),
            Self::ZeroLevels => write!(f, "dgc cluster-lod bridge: zero levels"),
            Self::ParentTableCountMismatch { tables, levels } => write!(
                f,
                "dgc cluster-lod bridge: {tables} parent tables for {levels} levels, expected levels-1"
            ),
            Self::ParentOutOfRange {
                parent,
                coarse_level,
            } => write!(
                f,
                "dgc cluster-lod bridge: parent {parent} out of range for coarse level {coarse_level}"
            ),
            Self::EmptyDag => write!(f, "DAG must contain at least one node."),
            Self::NodeBudgetExceeded { nodes } => {
                write!(
                    f,
                    "DAG node budget exceeded ({nodes} > {CLUSTER_LOD_MAX_NODES})."
                )
            }
            Self::DuplicateNodeId => write!(f, "Duplicate DAG node id."),
            Self::ChildrenAtLeafLevel { node } => {
                write!(f, "Node {node} has children at the leaf level.")
            }
            Self::UnknownChild { parent, child } => {
                write!(f, "Node {parent} references unknown child {child}.")
            }
            Self::ChildNotRefining { parent, child } => write!(
                f,
                "Node {parent} child {child} does not refine a coarser level."
            ),
            Self::InvertedBounds { node, axis } => {
                write!(f, "Node {node} has inverted bounds on axis {axis}.")
            }
            Self::ErrorNotStrictlyIncreasing { coarse, fine } => write!(
                f,
                "error must strictly increase per level (level {coarse} >= level {fine})"
            ),
            Self::LeafCoverageMismatch { covered, declared } => write!(
                f,
                "DAG leaves cover {covered} triangles but the geometry declares {declared}."
            ),
        }
    }
}

impl std::error::Error for ClusterLodDagRuntimeError {}

/// 合同签核(TS validateClusterLodDag 校验序 + 本端消费前置;独立暴露供反例注入)。
///
/// 校验序:预算 → 重复 id → 叶层挂子/子边(存在+细化方向)→ 包围盒 sanity →
/// 逐层误差严格递增 → 根可达叶子三角形区间并集(逐层去重,孤儿=仅该层可见额外叶子)
/// == leafTriangleTotal。
pub fn validate_cluster_lod_runtime_dag(
    nodes: &[ClusterLodNode],
    leaf_triangle_total: usize,
) -> Result<(), ClusterLodDagRuntimeError> {
    if nodes.is_empty() {
        return Err(ClusterLodDagRuntimeError::EmptyDag);
    }
    if nodes.len() > CLUSTER_LOD_MAX_NODES {
        return Err(ClusterLodDagRuntimeError::NodeBudgetExceeded { nodes: nodes.len() });
    }
    let ids: std::collections::HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
    if ids.len() != nodes.len() {
        return Err(ClusterLodDagRuntimeError::DuplicateNodeId);
    }
    let min_level = nodes
        .iter()
        .map(|node| node.level)
        .min()
        .expect("non-empty");
    for node in nodes {
        if !node.children.is_empty() && node.level <= min_level {
            return Err(ClusterLodDagRuntimeError::ChildrenAtLeafLevel {
                node: node.id.clone(),
            });
        }
        for child in &node.children {
            let Some(child_node) = nodes.iter().find(|candidate| candidate.id == *child) else {
                return Err(ClusterLodDagRuntimeError::UnknownChild {
                    parent: node.id.clone(),
                    child: child.clone(),
                });
            };
            if child_node.level >= node.level {
                return Err(ClusterLodDagRuntimeError::ChildNotRefining {
                    parent: node.id.clone(),
                    child: child.clone(),
                });
            }
        }
        for axis in 0..3 {
            if !matches!(
                node.bounds_min[axis].partial_cmp(&node.bounds_max[axis]),
                Some(core::cmp::Ordering::Less | core::cmp::Ordering::Equal)
            ) {
                return Err(ClusterLodDagRuntimeError::InvertedBounds {
                    node: node.id.clone(),
                    axis,
                });
            }
        }
    }
    // 逐层误差严格递增(单层 DAG 除外):同层节点共享 level.error,层间取每层误差比对。
    let mut level_errors: Vec<(usize, f64)> = nodes
        .iter()
        .map(|node| (node.level as usize, node.error))
        .collect();
    level_errors.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.partial_cmp(&b.1).unwrap_or(core::cmp::Ordering::Equal))
    });
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
            return Err(ClusterLodDagRuntimeError::ErrorNotStrictlyIncreasing {
                coarse: pair[0].0,
                fine: pair[1].0,
            });
        }
    }
    // 根可达叶子三角形区间并集(逐层去重)== leafTriangleTotal(孤儿覆盖裁决口径)。
    let by_id: std::collections::HashMap<&str, &ClusterLodNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let is_child: std::collections::HashSet<&str> = nodes
        .iter()
        .flat_map(|node| node.children.iter().map(String::as_str))
        .collect();
    let mut visited: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut leaf_intervals_by_level: std::collections::HashMap<usize, Vec<(u32, u32)>> =
        std::collections::HashMap::new();
    for node in nodes {
        if is_child.contains(node.id.as_str()) {
            continue;
        }
        let mut stack = vec![node.id.as_str()];
        while let Some(id) = stack.pop() {
            if !visited.insert(id) {
                continue;
            }
            let current = by_id.get(id).copied().expect("child id known");
            if current.children.is_empty() && current.triangle_count > 0 {
                leaf_intervals_by_level
                    .entry(current.level as usize)
                    .or_default()
                    .push((
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
    if covered != leaf_triangle_total {
        return Err(ClusterLodDagRuntimeError::LeafCoverageMismatch {
            covered,
            declared: leaf_triangle_total,
        });
    }
    Ok(())
}

/// 父表 O(n) 反转(childrenByLevel[k][p] = 引用粗层 k+1 簇 p 的细层 k 簇列表)。
fn invert_parents(dag: &MeshletDag) -> Result<Vec<Vec<Vec<usize>>>, ClusterLodDagRuntimeError> {
    if dag.levels.is_empty() {
        return Err(ClusterLodDagRuntimeError::ZeroLevels);
    }
    if dag.parents_by_level.len() != dag.levels.len() - 1 {
        return Err(ClusterLodDagRuntimeError::ParentTableCountMismatch {
            tables: dag.parents_by_level.len(),
            levels: dag.levels.len(),
        });
    }
    let mut children_by_level: Vec<Vec<Vec<usize>>> =
        Vec::with_capacity(dag.parents_by_level.len());
    for (k, parents) in dag.parents_by_level.iter().enumerate() {
        if parents.len() != dag.levels[k].meshlet_count {
            return Err(ClusterLodDagRuntimeError::ParentTableCountMismatch {
                tables: parents.len(),
                levels: dag.levels[k].meshlet_count,
            });
        }
        let coarse_count = dag.levels[k + 1].meshlet_count;
        let mut children = vec![Vec::new(); coarse_count];
        for (c, &parent) in parents.iter().enumerate() {
            if parent != NO_PARENT {
                if parent as usize >= coarse_count {
                    return Err(ClusterLodDagRuntimeError::ParentOutOfRange {
                        parent,
                        coarse_level: k + 1,
                    });
                }
                children[parent as usize].push(c);
            }
        }
        children_by_level.push(children);
    }
    Ok(children_by_level)
}

fn map_nodes(dag: &MeshletDag) -> Result<Vec<ClusterLodNode>, ClusterLodDagRuntimeError> {
    let children_by_level = invert_parents(dag)?;
    let mut nodes = Vec::new();
    for (k, level) in dag.levels.iter().enumerate() {
        let children_of_level: &[Vec<usize>] = if k > 0 {
            &children_by_level[k - 1]
        } else {
            &[]
        };
        for c in 0..level.meshlet_count {
            let base = c * 16;
            let children: Vec<String> = children_of_level
                .get(c)
                .map(|fine| {
                    fine.iter()
                        .map(|child| format!("l{}-c{}", k - 1, child))
                        .collect()
                })
                .unwrap_or_default();
            nodes.push(ClusterLodNode {
                id: format!("l{k}-c{c}"),
                level: k as u32,
                error: level.error,
                bounds_min: [
                    f64::from(level.bounds[base + 4]),
                    f64::from(level.bounds[base + 5]),
                    f64::from(level.bounds[base + 6]),
                ],
                bounds_max: [
                    f64::from(level.bounds[base + 8]),
                    f64::from(level.bounds[base + 9]),
                    f64::from(level.bounds[base + 10]),
                ],
                first_triangle: level.descriptors[c * 4 + 2],
                triangle_count: level.descriptors[c * 4 + 3],
                children,
            });
        }
    }
    Ok(nodes)
}

impl ClusterLodDagRuntime {
    /// `.dgc` 字节 → 运行时 DAG(read_dgc 全校验链 → 路 4 映射 → 合同签核 → 打包)。
    ///
    /// # Errors
    /// 解析链(geometry_dag::DagError)或映射/签核([`ClusterLodDagRuntimeError`])任一失败。
    pub fn from_dgc(bytes: &[u8], geometry_id: &str) -> Result<Self, ClusterLodDagRuntimeError> {
        if geometry_id.is_empty() {
            return Err(ClusterLodDagRuntimeError::GeometryIdRequired);
        }
        let dag = read_dgc(bytes)
            .map_err(|error| ClusterLodDagRuntimeError::DgcParse(error.to_string()))?;
        Self::from_parsed_dag(dag, geometry_id)
    }

    /// 已过 read_dgc 全校验链的 DAG → 运行时(内部入口;公开面只收字节)。
    fn from_parsed_dag(
        dag: MeshletDag,
        geometry_id: &str,
    ) -> Result<Self, ClusterLodDagRuntimeError> {
        let nodes = map_nodes(&dag)?;
        let leaf_triangle_total = dag.levels[0].indices.len() / 3;
        validate_cluster_lod_runtime_dag(&nodes, leaf_triangle_total)?;
        // 64B 打包:cluster_index = 层内序号(节点序 level 升序+层内升序,运行计数即序号)。
        let mut node_storage = Vec::with_capacity(nodes.len() * CLUSTER_LOD_NODE_STRIDE_BYTES);
        let mut per_level_cursor: std::collections::HashMap<u32, u32> =
            std::collections::HashMap::new();
        for node in &nodes {
            let cluster_index = per_level_cursor.entry(node.level).or_insert(0);
            node_storage.extend_from_slice(&pack_cluster_lod_node(node, *cluster_index));
            *cluster_index += 1;
        }
        let plan_nodes: Vec<ClusterLodPlanNode> = nodes
            .iter()
            .map(|node| ClusterLodPlanNode {
                id: node.id.clone(),
                level: node.level as usize,
                children: node.children.clone(),
                first_triangle: node.first_triangle as usize,
                triangle_count: node.triangle_count as usize,
            })
            .collect();
        let mut level_summaries = Vec::with_capacity(dag.levels.len());
        let mut vertex_buffer = Vec::new();
        let mut index_buffer = Vec::new();
        for level in &dag.levels {
            level_summaries.push(ClusterLodLevelGeometrySummary {
                vertex_count: level.positions.len() / 3,
                index_count: level.indices.len(),
            });
            vertex_buffer.extend_from_slice(&level.positions);
            index_buffer.extend_from_slice(&level.indices);
        }
        Ok(Self {
            geometry_id: geometry_id.to_string(),
            nodes,
            node_storage,
            plan_nodes,
            level_summaries,
            vertex_buffer,
            index_buffer,
            leaf_triangle_total,
            level_count: dag.levels.len(),
        })
    }
}
