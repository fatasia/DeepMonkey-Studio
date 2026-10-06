//! Cluster LOD 选中槽位 → indexed-indirect 绘制参数计划(TS
//! `rayTracing/clusterLodIndirectPlan.ts` 逐式同构;纯函数无 GPU 依赖)。
//!
//! == 合同(与 TS 单源逐项对应,禁止单侧改动) ==
//! 1. 绘制节点 = (选中 或 已是叶) 且 (是根 或 父未选中);每个叶子 cluster 恰被一个
//!    前沿绘制覆盖(前沿闭合校验 fail-closed)。
//! 2. indirectCommand = draw-indexed-indirect 5×u32
//!    (indexCount, instanceCount, firstIndex, baseVertex, firstInstance),20B 步长。
//! 3. fail-closed:槽位长度不匹配/槽位值既非哨兵也非节点层级/子被双父引用/层级规模
//!    摘要缺失或违规/前沿闭合破坏 → [`ClusterLodPlanError`],绝不静默降级。
//! 4. 空 cluster(triangleCount=0)保留为 indexCount=0 的 no-op 绘制槽位。

/// draw-indexed-indirect 记录字节数(5×u32)。
pub const CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES: usize = 20;
/// 未选中哨兵(re-export 语义;与 selection 模块同源)。
pub const CLUSTER_LOD_REFINE_SENTINEL: u32 = super::gpu_cluster_lod_selection::CLUSTER_LOD_REFINE_SENTINEL;

/// 层几何规模摘要(调用方从 { vertices, indices } 映射)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClusterLodLevelGeometrySummary {
    pub vertex_count: usize,
    pub index_count: usize,
}

/// 每层拼接基址跨度(level 升序)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClusterLodLevelSpan {
    pub level: usize,
    /// 拼接 index buffer 内本层基址(以 u32 index 计)。
    pub first_index_base: usize,
    pub index_count: usize,
    /// 拼接 vertex buffer 内本层基址(以顶点计)。
    pub base_vertex: usize,
    pub vertex_count: usize,
}

/// 计划输入节点(仅 plan 所需字段;id/level/children/firstTriangle/triangleCount)。
#[derive(Clone, Debug)]
pub struct ClusterLodPlanNode {
    pub id: String,
    pub level: usize,
    pub children: Vec<String>,
    pub first_triangle: usize,
    pub triangle_count: usize,
}

/// 一条前沿绘制。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClusterLodIndirectDraw {
    pub node_index: usize,
    pub node_id: String,
    pub level: usize,
    /// 层内 cluster 序号(与 pack 的 per-level 顺序计数一致)。
    pub cluster_index: usize,
    pub first_triangle: usize,
    pub triangle_count: usize,
    /// 拼接 index buffer 内全局 firstIndex = spans[level].first_index_base + first_triangle × 3。
    pub first_index: usize,
    /// 5×u32 命令字(indexCount, instanceCount, firstIndex, baseVertex, firstInstance)。
    pub indirect_command: [u32; 5],
}

/// indirect 绘制参数计划。
pub struct ClusterLodIndirectPlan {
    /// 绘制清单,从粗到细排序(level 降序,同层按节点顺序);每根区域恰一条。
    pub draws: Vec<ClusterLodIndirectDraw>,
    /// 每层拼接基址跨度,level 升序。
    pub level_spans: Vec<ClusterLodLevelSpan>,
    pub draw_count: usize,
    /// indirect buffer 目标字节数 = draw_count × 20。
    pub commands_byte_length: usize,
    /// 根区域数(信息性)。
    pub covered_regions: usize,
    /// 恰被一次前沿绘制覆盖的叶子 cluster 数。
    pub covered_leaf_clusters: usize,
}

/// fail-closed 错误族(TS 抛错文本同语义)。
#[derive(Clone, Debug, PartialEq)]
pub enum ClusterLodPlanError {
    SelectionLengthMismatch { selection: usize, nodes: usize },
    InvalidLevel { node: String, level: isize },
    SlotInvalid { slot: usize, value: u32, level: usize },
    ChildClaimedTwice { child: String, first: String, second: String },
    LevelSummaryMissing { summaries: usize, max_level: usize },
    LevelSummaryInvalid { level: usize },
    FrontierClosureBroken { leaf: String, covered: usize },
}

impl core::fmt::Display for ClusterLodPlanError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::SelectionLengthMismatch { selection, nodes } => write!(
                f,
                "Cluster LOD selection length {selection} does not match DAG node count {nodes}."
            ),
            Self::InvalidLevel { node, level } => {
                write!(f, "Cluster LOD node {node} carries an invalid level {level}.")
            }
            Self::SlotInvalid { slot, value, level } => write!(
                f,
                "Cluster LOD selection slot {slot} carries {value}, expected sentinel or node level {level}."
            ),
            Self::ChildClaimedTwice { child, first, second } => write!(
                f,
                "Cluster LOD DAG child {child} is claimed by both {first} and {second}."
            ),
            Self::LevelSummaryMissing { summaries, max_level } => write!(
                f,
                "Cluster LOD level summaries ({summaries}) do not cover DAG level {max_level}."
            ),
            Self::LevelSummaryInvalid { level } => write!(
                f,
                "Cluster LOD level {level} geometry summary must be nonnegative safe integers."
            ),
            Self::FrontierClosureBroken { leaf, covered } => write!(
                f,
                "Cluster LOD frontier closure broken: leaf {leaf} is covered by {covered} frontier draws."
            ),
        }
    }
}

fn build_parent_of(nodes: &[ClusterLodPlanNode]) -> Result<std::collections::HashMap<String, String>, ClusterLodPlanError> {
    let mut parent_of: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for node in nodes {
        for child in &node.children {
            if let Some(existing) = parent_of.get(child) {
                return Err(ClusterLodPlanError::ChildClaimedTwice {
                    child: child.clone(),
                    first: existing.clone(),
                    second: node.id.clone(),
                });
            }
            parent_of.insert(child.clone(), node.id.clone());
        }
    }
    Ok(parent_of)
}

fn validate_selection(
    nodes: &[ClusterLodPlanNode],
    selection: &[u32],
) -> Result<(), ClusterLodPlanError> {
    if selection.len() != nodes.len() {
        return Err(ClusterLodPlanError::SelectionLengthMismatch {
            selection: selection.len(),
            nodes: nodes.len(),
        });
    }
    for (index, node) in nodes.iter().enumerate() {
        let value = selection[index];
        if value == CLUSTER_LOD_REFINE_SENTINEL {
            continue;
        }
        if value as usize != node.level {
            return Err(ClusterLodPlanError::SlotInvalid {
                slot: index,
                value,
                level: node.level,
            });
        }
    }
    Ok(())
}

/// 前沿派生(与 select 的 frontier 逐节点同语义;返回从粗到细排序的节点下标)。
pub fn derive_cluster_lod_frontier(
    nodes: &[ClusterLodPlanNode],
    selection: &[u32],
) -> Result<Vec<usize>, ClusterLodPlanError> {
    validate_selection(nodes, selection)?;
    let parent_of = build_parent_of(nodes)?;
    let index_of: std::collections::HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id.as_str(), index))
        .collect();
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by(|left, right| {
        nodes[*right]
            .level
            .cmp(&nodes[*left].level)
            .then(left.cmp(right))
    });
    let mut frontier = Vec::new();
    for index in order {
        let node = &nodes[index];
        let reaches_frontier =
            selection[index] != CLUSTER_LOD_REFINE_SENTINEL || node.children.is_empty();
        if !reaches_frontier {
            continue;
        }
        let parent_selected = parent_of
            .get(&node.id)
            .and_then(|parent_id| {
                nodes
                    .iter()
                    .position(|candidate| candidate.id == *parent_id)
            })
            .map(|parent_index| selection[parent_index] != CLUSTER_LOD_REFINE_SENTINEL)
            .unwrap_or(false);
        if !parent_selected {
            frontier.push(index);
        }
    }
    Ok(frontier)
}

/// 选中槽位 → indirect 绘制参数计划(任何不一致 fail-closed)。
pub fn plan_cluster_lod_indirect(
    nodes: &[ClusterLodPlanNode],
    selection: &[u32],
    levels: &[ClusterLodLevelGeometrySummary],
) -> Result<ClusterLodIndirectPlan, ClusterLodPlanError> {
    validate_selection(nodes, selection)?;
    let max_level = nodes.iter().map(|node| node.level).max().unwrap_or(0);
    if levels.len() <= max_level {
        return Err(ClusterLodPlanError::LevelSummaryMissing {
            summaries: levels.len(),
            max_level,
        });
    }
    for (level, summary) in levels.iter().enumerate() {
        if summary.index_count > usize::MAX || summary.vertex_count > usize::MAX {
            return Err(ClusterLodPlanError::LevelSummaryInvalid { level });
        }
    }
    let mut level_spans = Vec::with_capacity(levels.len());
    let mut first_index_base = 0usize;
    let mut base_vertex = 0usize;
    for (level, summary) in levels.iter().enumerate() {
        level_spans.push(ClusterLodLevelSpan {
            level,
            first_index_base,
            index_count: summary.index_count,
            base_vertex,
            vertex_count: summary.vertex_count,
        });
        first_index_base += summary.index_count;
        base_vertex += summary.vertex_count;
    }
    let frontier = derive_cluster_lod_frontier(nodes, selection)?;
    let parent_of = build_parent_of(nodes)?;
    let mut per_level: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    let mut cluster_index_of: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for node in nodes {
        let next = per_level.get(&node.level).copied().unwrap_or(0);
        per_level.insert(node.level, next + 1);
        cluster_index_of.insert(node.id.clone(), next);
    }
    let mut draws = Vec::with_capacity(frontier.len());
    for node_index in frontier {
        let node = &nodes[node_index];
        let span = level_spans
            .get(node.level)
            .expect("frontier level covered by summaries guard");
        let first_index = span.first_index_base + node.first_triangle * 3;
        draws.push(ClusterLodIndirectDraw {
            node_index,
            node_id: node.id.clone(),
            level: node.level,
            cluster_index: cluster_index_of[&node.id],
            first_triangle: node.first_triangle,
            triangle_count: node.triangle_count,
            first_index,
            indirect_command: [
                (node.triangle_count * 3) as u32,
                1,
                first_index as u32,
                span.base_vertex as u32,
                0,
            ],
        });
    }
    // 前沿闭合校验:每个叶子沿父链到根恰有一个前沿绘制。
    let drawn: std::collections::HashSet<&str> =
        draws.iter().map(|draw| nodes[draw.node_index].id.as_str()).collect();
    let mut covered_leaf_clusters = 0usize;
    for leaf in nodes {
        if !leaf.children.is_empty() {
            continue;
        }
        let mut on_path = 0usize;
        let mut cursor: Option<&String> = Some(&leaf.id);
        while let Some(id) = cursor {
            if drawn.contains(id.as_str()) {
                on_path += 1;
            }
            cursor = parent_of.get(id);
        }
        if on_path != 1 {
            return Err(ClusterLodPlanError::FrontierClosureBroken {
                leaf: leaf.id.clone(),
                covered: on_path,
            });
        }
        covered_leaf_clusters += 1;
    }
    let covered_regions = nodes.iter().filter(|node| {
        !parent_of.contains_key(&node.id)
    }).count();
    Ok(ClusterLodIndirectPlan {
        draw_count: draws.len(),
        commands_byte_length: draws.len() * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES,
        covered_regions,
        covered_leaf_clusters,
        draws,
        level_spans,
    })
}
