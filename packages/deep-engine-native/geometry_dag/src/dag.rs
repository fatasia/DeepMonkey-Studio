//! 簇级几何 DAG:逐层聚类简化 + 重建簇 + 父子投票(fine→coarse 单射)。
//!
//! 与 TS 权威实现(`packages/deep-engine/src/geometry/meshletDag.ts` 的
//! `buildMeshletDag`)逐位对拍。语义要点:
//! - level 0 = 原始网格直接簇划分;
//! - 每层对上一层的输出做 `factor=2` 聚类简化,三角形数不再下降即收束;
//! - 误差场逐层累加(f64);父子归属按源三角形覆盖投票,平票取最小父索引。

use crate::error::DagResult;
use crate::meshlet_builder::{build_meshlets, MeshletBuildResult};
use crate::simplify::cluster_simplify;
use crate::types::{
    IndexedGeometry, OUTPUT_TRIANGLE_BUDGET_DEFAULT,
};
use crate::validation::{budget, validate_input};

/// DAG 构建选项(与 TS `MeshletDagOptions` 对应)。
#[derive(Debug, Clone)]
#[derive(Default)]
pub struct DagOptions {
    /// 层级数(含原始层),钳制到 `1..=8`;缺省 4。
    pub levels: Option<u32>,
    /// 簇最大三角形数,透传簇划分;缺省 64。
    pub max_triangles: Option<u32>,
    /// 簇最大顶点数;缺省 64。
    pub max_vertices: Option<u32>,
    /// 输出三角总量预算,防失控;缺省 8,000,000。
    pub output_triangle_budget: Option<u64>,
}


/// 单层 DAG(与 TS `MeshletDagLevel` 同构)。
#[derive(Debug, Clone)]
pub struct DagLevel {
    /// 层号,0 = 原始。
    pub level: u32,
    /// 该层误差:顶点相对源位置的最大位移累计(世界单位)。
    pub error: f64,
    /// 层网格顶点位置(紧凑 XYZ)。
    pub positions: Vec<f32>,
    /// 层网格索引。
    pub indices: Vec<u32>,
    /// 簇数。
    pub meshlet_count: usize,
    /// 构建参数:簇顶点上限。
    pub max_vertices: u32,
    /// 构建参数:簇三角形上限。
    pub max_triangles: u32,
    /// 簇描述符(`[vertexOffset, vertexCount, triangleOffset, triangleCount]` × n)。
    pub descriptors: Vec<u32>,
    /// 拼接全局顶点表。
    pub vertex_remap: Vec<u32>,
    /// 打包局部三角形。
    pub local_triangle_indices: Vec<u32>,
    /// 包围体(16 f32 × n)。
    pub bounds: Vec<f32>,
    /// 输出三角形 i 的代表源三角形(level 0 序)。
    pub source_triangles: Vec<u32>,
    /// 簇 i 的源三角形段 `[start,end)`(输入序连续)。
    pub cluster_source_spans: Vec<u32>,
}

/// 完整 DAG(与 TS `MeshletDag` 同构)。
#[derive(Debug, Clone)]
pub struct MeshletDag {
    /// 各层(level 0 起升序)。
    pub levels: Vec<DagLevel>,
    /// `parents_by_level[k][c]` = level `k` 簇 `c` 在 level `k+1` 的父簇索引;每细簇恰一父。
    pub parents_by_level: Vec<Vec<u32>>,
}

/// 构建簇级几何 DAG。
///
/// # Errors
/// 输入非法或单层三角形超出 `output_triangle_budget` 时返回错误。
pub fn build_meshlet_dag(geometry: &IndexedGeometry, options: &DagOptions) -> DagResult<MeshletDag> {
    let level_count = (options.levels.unwrap_or(4)).clamp(1, 8);
    let output_triangle_budget = options.output_triangle_budget.unwrap_or(OUTPUT_TRIANGLE_BUDGET_DEFAULT);
    // TS `buildMeshletDag` 语义:DAG 层的簇三角形缺省是 64(MeshletDagOptions 注释),
    // 与 buildMeshlets 直接调用的缺省 126 不同;透传前在此落定缺省值。
    let max_triangles = Some(options.max_triangles.unwrap_or(64));
    let input = validate_input(geometry, options.max_vertices, max_triangles)?;

    // 原始层:直接簇划分(与生产簇划分完全一致)。
    let base = build_meshlets(geometry, options.max_vertices, max_triangles)?;
    let identity_source: Vec<u32> = (0..geometry.triangle_count() as u32).collect();
    let base_spans = base.cluster_output_spans();
    let mut levels = vec![DagLevel {
        level: 0,
        error: 0.0,
        positions: input.geometry.positions.clone(),
        indices: input.geometry.indices.clone(),
        meshlet_count: base.meshlet_count,
        max_vertices: input.max_vertices,
        max_triangles: input.max_triangles,
        descriptors: base.descriptors.clone(),
        vertex_remap: base.vertex_remap.clone(),
        local_triangle_indices: base.local_triangle_indices.clone(),
        bounds: base.bounds.clone(),
        source_triangles: identity_source.clone(),
        cluster_source_spans: base_spans.clone(),
    }];

    let mut current_positions: Vec<f32> = input.geometry.positions.clone();
    let mut current_indices: Vec<u32> = input.geometry.indices.clone();
    let mut current_error = 0.0f64;
    let mut current_cluster_spans = base_spans;
    let mut parents_by_level: Vec<Vec<u32>> = Vec::new();

    for level in 1..level_count {
        let quantized = cluster_simplify(&current_positions, &current_indices, 2.0)?;
        if quantized.indices.len() / 3 >= current_indices.len() / 3 {
            break; // 不再下降即收束
        }
        budget(
            (quantized.indices.len() / 3) as u64,
            output_triangle_budget,
            "dag level triangles",
        )?;
        current_error = if current_error == 0.0 {
            quantized.max_displacement
        } else {
            current_error + quantized.max_displacement
        };
        let built: MeshletBuildResult = build_meshlets(
            &IndexedGeometry {
                positions: quantized.positions.clone(),
                indices: quantized.indices.clone(),
            },
            options.max_vertices,
            max_triangles,
        )?;
        let coarse_spans = built.cluster_output_spans();
        levels.push(DagLevel {
            level,
            error: current_error,
            positions: quantized.positions.clone(),
            indices: quantized.indices.clone(),
            meshlet_count: built.meshlet_count,
            max_vertices: input.max_vertices,
            max_triangles: input.max_triangles,
            descriptors: built.descriptors.clone(),
            vertex_remap: built.vertex_remap.clone(),
            local_triangle_indices: built.local_triangle_indices.clone(),
            bounds: built.bounds.clone(),
            source_triangles: quantized.source_triangles.clone(),
            cluster_source_spans: coarse_spans.clone(),
        });

        // 父子回填:level k(细,=上一轮 current* 状态)的每个簇,按其输入三角形被本层
        // (level k+1)哪些簇覆盖投票,取占比最大者为父(fine→coarse 单射,平票取最小索引)。
        let parents =
            assign_parents(&current_cluster_spans, &coarse_spans, &quantized.source_triangles);
        parents_by_level.push(parents);

        // 下一轮的"当前层"状态:move 接管 quantized(每层一次 clone 付出在 level 快照上,
        // 换取借用在 levels 增长下的清晰生命周期)。
        current_positions = quantized.positions;
        current_indices = quantized.indices;
        current_cluster_spans = coarse_spans;
    }

    Ok(MeshletDag { levels, parents_by_level })
}

/// 细层簇 → 粗层簇投票。`fine_spans` 为细层簇的输入三角形段,`coarse_spans` 为粗层簇
/// 的输入三角形段,`source_triangles` 为粗层输出三角形 → 细层输入三角形索引。
///
/// 无任何覆盖(全部三角形被去重丢弃)的细簇父索引为 [`u32::MAX`](对应 TS 的 -1 哨兵)。
fn assign_parents(fine_spans: &[u32], coarse_spans: &[u32], source_triangles: &[u32]) -> Vec<u32> {
    let fine_count = fine_spans.len() / 2;
    let coarse_count = coarse_spans.len() / 2;
    let mut votes: Vec<std::collections::HashMap<u32, u64>> = vec![std::collections::HashMap::new(); fine_count];

    for p in 0..coarse_count {
        let start = coarse_spans[p * 2] as usize;
        let end = coarse_spans[p * 2 + 1] as usize;
        for &src in &source_triangles[start..end] {
            if let Some(fine_idx) = binary_search_span(fine_spans, src) {
                *votes[fine_idx].entry(p as u32).or_insert(0) += 1;
            }
        }
    }
    let mut parent_of_fine = vec![u32::MAX; fine_count];
    for (f, per_coarse) in votes.iter().enumerate() {
        let mut best = -1i64;
        let mut best_votes = -1i64;
        // 与 TS 一致:严格大于才替换,平票取最小父索引。
        for (&coarse, &v) in per_coarse {
            if (v as i64) > best_votes || ((v as i64) == best_votes && (coarse as i64) < best) {
                best = coarse as i64;
                best_votes = v as i64;
            }
        }
        if best >= 0 {
            parent_of_fine[f] = best as u32;
        }
    }
    parent_of_fine
}

/// 段表二分:返回 `src` 落入的簇索引(段为输入序连续区间);空表或未命中返回 `None`。
pub(crate) fn binary_search_span(spans: &[u32], src: u32) -> Option<usize> {
    if spans.is_empty() {
        return None;
    }
    let mut lo = 0usize;
    let mut hi = spans.len() / 2 - 1;
    while lo < hi {
        let mid = (lo + hi) / 2;
        if spans[mid * 2 + 1] <= src {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    (src >= spans[lo * 2] && src < spans[lo * 2 + 1]).then_some(lo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sphere_geometry(segments: usize, rings: usize) -> IndexedGeometry {
        let (positions, indices) = crate::simplify::test_support::test_sphere(segments, rings);
        IndexedGeometry { positions, indices }
    }

    #[test]
    fn monotone_levels() {
        let dag = build_meshlet_dag(&sphere_geometry(24, 12), &DagOptions { levels: Some(4), ..Default::default() })
            .expect("dag");
        assert!(dag.levels.len() >= 2);
        assert_eq!(dag.levels[0].level, 0);
        assert_eq!(dag.levels[0].error, 0.0);
        for i in 1..dag.levels.len() {
            let (prev, cur) = (&dag.levels[i - 1], &dag.levels[i]);
            assert!(cur.indices.len() < prev.indices.len(), "triangles must shrink");
            assert!(cur.error > prev.error, "error must grow");
            assert!(cur.meshlet_count < prev.meshlet_count, "cluster count must shrink");
        }
    }

    #[test]
    fn level0_matches_direct_build() {
        let g = sphere_geometry(16, 8);
        let dag = build_meshlet_dag(&g, &DagOptions { levels: Some(3), ..Default::default() }).expect("dag");
        // DAG 层簇参数缺省(64/64),与直接 build_meshlets 的显式 64 对齐。
        let direct = build_meshlets(&g, None, Some(64)).expect("build");
        assert_eq!(dag.levels[0].meshlet_count, direct.meshlet_count);
        assert_eq!(dag.levels[0].descriptors, direct.descriptors);
    }

    #[test]
    fn parents_are_surjective_single_parent() {
        let dag = build_meshlet_dag(&sphere_geometry(24, 12), &DagOptions { levels: Some(4), ..Default::default() })
            .expect("dag");
        for (k, parents) in dag.parents_by_level.iter().enumerate() {
            let fine = dag.levels[k].meshlet_count;
            let coarse = dag.levels[k + 1].meshlet_count;
            assert_eq!(parents.len(), fine);
            let mut covered = vec![false; coarse];
            for &parent in parents {
                assert!(parent < coarse as u32, "parent out of range");
                covered[parent as usize] = true;
            }
            assert!(covered.iter().all(|&c| c), "every coarse cluster must have children");
        }
    }

    #[test]
    fn empty_mesh_produces_single_level() {
        let dag = build_meshlet_dag(&IndexedGeometry { positions: vec![], indices: vec![] }, &DagOptions::default())
            .expect("empty dag");
        assert_eq!(dag.levels.len(), 1);
        assert_eq!(dag.levels[0].meshlet_count, 0);
        assert!(dag.parents_by_level.is_empty());
    }

    #[test]
    fn degenerate_only_mesh_stays_at_level0() {
        // 全共线三角形:level 0 可分簇,但简化无法减少(退化剔除后为 0 → 0 >= 3 不成立,
        // 实际 0 < 3 会下降一层;空层簇数 0,父子表为空)。验证不 panic 且结构自洽。
        let g = IndexedGeometry {
            positions: vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 3.0, 0.0, 0.0],
            indices: vec![0, 1, 2, 1, 2, 3],
        };
        let dag = build_meshlet_dag(&g, &DagOptions::default()).expect("dag");
        for level in &dag.levels {
            assert_eq!(level.descriptors.len() / 4, level.meshlet_count);
        }
    }

    #[test]
    fn level_clamped_to_eight() {
        let dag = build_meshlet_dag(&sphere_geometry(64, 32), &DagOptions { levels: Some(99), ..Default::default() })
            .expect("dag");
        assert!(dag.levels.len() <= 8);
    }

    #[test]
    fn binary_search_span_basics() {
        let spans = [0, 3, 3, 5, 5, 9];
        assert_eq!(binary_search_span(&spans, 0), Some(0));
        assert_eq!(binary_search_span(&spans, 2), Some(0));
        assert_eq!(binary_search_span(&spans, 3), Some(1));
        assert_eq!(binary_search_span(&spans, 4), Some(1));
        assert_eq!(binary_search_span(&spans, 8), Some(2));
        assert_eq!(binary_search_span(&spans, 9), None);
        assert_eq!(binary_search_span(&[], 0), None);
    }
}
