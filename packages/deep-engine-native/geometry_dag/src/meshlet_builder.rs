//! 贪心簇(meshlet)划分:按输入三角形序装箱,顶点/三角形双上限,flush 前移判定。
//!
//! 与 TS 权威实现(`packages/deep-engine/src/geometry/meshletBuilder.ts`)逐位对拍:
//! 输出描述符布局、顶点表拼接序、局部三角形打包、包围体排布全部一致。

use crate::bounds::{compute_meshlet_bounds, triangle_normal};
use crate::error::{DagError, DagResult};
use crate::local_triangle::pack_local_triangle;
use crate::types::{
    IndexedGeometry, MESHLET_BOUNDS_STRIDE, MESHLET_DESCRIPTOR_STRIDE, MESHLET_SCHEMA_VERSION,
    OUTPUT_MESHLETS_BUDGET, PendingMeshlet,
};
use crate::validation::{budget, validate_input, ValidatedInput};

/// 输出字节预算(TS `MESHLET_BUILD_BUDGETS.outputBytes`,512 MiB)。
const OUTPUT_BYTES_BUDGET: u64 = 512 * 1024 * 1024;

/// 单次簇划分输出(与 TS `MeshletBuildResult` 同构)。
#[derive(Debug, Clone)]
pub struct MeshletBuildResult {
    /// schema 版本。
    pub schema_version: u32,
    /// 源顶点数。
    pub source_vertex_count: usize,
    /// 源三角形数。
    pub source_triangle_count: usize,
    /// 簇数。
    pub meshlet_count: usize,
    /// 本次构建采用的簇顶点上限。
    pub max_vertices: u32,
    /// 本次构建采用的簇三角形上限。
    pub max_triangles: u32,
    /// 簇描述符 `[vertexOffset, vertexCount, triangleOffset, triangleCount]` × n。
    pub descriptors: Vec<u32>,
    /// 拼接的全局顶点表(局部→全局映射)。
    pub vertex_remap: Vec<u32>,
    /// 打包局部三角形(低 24 位:三个 8-bit 局部索引)。
    pub local_triangle_indices: Vec<u32>,
    /// 包围体(16 f32 × n,布局见 [`crate::bounds::MeshletBounds::to_flat`])。
    pub bounds: Vec<f32>,
}

impl MeshletBuildResult {
    /// 簇 `i` 的输出三角形段 `[start, end)`,与簇序一致(descriptors 三角形数前缀和)。
    ///
    /// 返回长度为 `2 * meshlet_count` 的平铺段表。
    #[must_use]
    pub fn cluster_output_spans(&self) -> Vec<u32> {
        let mut spans = Vec::with_capacity(self.meshlet_count * 2);
        let mut start = 0u32;
        for i in 0..self.meshlet_count {
            let count = self.descriptors[i * MESHLET_DESCRIPTOR_STRIDE + 3];
            spans.push(start);
            spans.push(start + count);
            start += count;
        }
        spans
    }
}

/// 对索引化三角形网格做贪心簇划分。
///
/// 算法与 TS `buildMeshlets` 一致:按输入序逐三角形装箱;加入新三角形前先判
/// `triangleCount >= maxTriangles || vertexCount + addedVertices > maxVertices`,
/// 触顶即 flush;局部顶点按首次出现序编号。
///
/// # Errors
/// 输入非法(见 [`validate_input`])或超出输出预算(簇数 / 总字节)时返回错误。
pub fn build_meshlets(
    geometry: &IndexedGeometry,
    max_vertices: Option<u32>,
    max_triangles: Option<u32>,
) -> DagResult<MeshletBuildResult> {
    let input: ValidatedInput = validate_input(geometry, max_vertices, max_triangles)?;
    let positions: &[f32] = &input.geometry.positions;

    let mut output = Accumulator::default();
    let mut pending = PendingMeshlet::new();
    let indices = &input.geometry.indices;
    let mut offset = 0;
    while offset < indices.len() {
        let global = [indices[offset], indices[offset + 1], indices[offset + 2]];
        let mut added_vertices = if pending.contains_global(global[0]) { 0 } else { 1 };
        if global[1] != global[0] && !pending.contains_global(global[1]) {
            added_vertices += 1;
        }
        if global[2] != global[0] && global[2] != global[1] && !pending.contains_global(global[2]) {
            added_vertices += 1;
        }
        if pending.triangles.len() as u32 >= input.max_triangles
            || pending.vertices.len() as u32 + added_vertices as u32 > input.max_vertices
        {
            output.flush(positions, &mut pending)?;
        }
        let local = [
            pending.local_vertex(global[0]),
            pending.local_vertex(global[1]),
            pending.local_vertex(global[2]),
        ];
        pending
            .triangles
            .push(pack_local_triangle(local[0], local[1], local[2])?);
        match triangle_normal(positions, global[0], global[1], global[2]) {
            Some(normal) => pending.normals.push(normal),
            None => pending.has_degenerate = true,
        }
        offset += 3;
    }
    output.flush(positions, &mut pending)?;

    Ok(MeshletBuildResult {
        schema_version: MESHLET_SCHEMA_VERSION,
        source_vertex_count: input.geometry.vertex_count(),
        source_triangle_count: input.geometry.triangle_count(),
        meshlet_count: output.descriptors.len() / MESHLET_DESCRIPTOR_STRIDE,
        max_vertices: input.max_vertices,
        max_triangles: input.max_triangles,
        descriptors: output.descriptors,
        vertex_remap: output.remap,
        local_triangle_indices: output.triangles,
        bounds: output.bounds,
    })
}

/// 输出累积器:把 `PendingMeshlet` 固化为描述符 + 顶点表 + 局部三角形 + 包围体,
/// 并逐次执行簇数 / 字节预算护栏(与 TS `flush` + `assertOutputBudget` 等价)。
#[derive(Default)]
struct Accumulator {
    descriptors: Vec<u32>,
    remap: Vec<u32>,
    triangles: Vec<u32>,
    bounds: Vec<f32>,
}

impl Accumulator {
    fn flush(&mut self, positions: &[f32], pending: &mut PendingMeshlet) -> DagResult<()> {
        if pending.triangles.is_empty() {
            return Ok(());
        }
        budget(
            (self.descriptors.len() / MESHLET_DESCRIPTOR_STRIDE + 1) as u64,
            OUTPUT_MESHLETS_BUDGET,
            "output meshlets",
        )?;
        self.descriptors.extend_from_slice(&[
            self.remap.len() as u32,
            pending.vertices.len() as u32,
            self.triangles.len() as u32,
            pending.triangles.len() as u32,
        ]);
        self.remap.extend_from_slice(&pending.vertices);
        self.triangles.extend_from_slice(&pending.triangles);
        let meshlet_bounds =
            compute_meshlet_bounds(positions, &pending.vertices, &pending.normals, pending.has_degenerate)?;
        self.bounds.extend_from_slice(&meshlet_bounds.to_flat());
        assert_output_budget(
            self.descriptors.len(),
            self.remap.len(),
            self.triangles.len(),
            self.bounds.len(),
        )?;
        *pending = PendingMeshlet::new();
        Ok(())
    }
}

/// TS `assertOutputBudget`:输出总量与布局对齐护栏。
fn assert_output_budget(
    descriptors: usize,
    remap: usize,
    triangles: usize,
    bounds: usize,
) -> DagResult<()> {
    let bytes = (descriptors + remap + triangles + bounds) as u64 * 4;
    if bytes > OUTPUT_BYTES_BUDGET {
        return Err(DagError::budget_exceeded(
            format!("Meshlet output exceeds {OUTPUT_BYTES_BUDGET} bytes"),
            OUTPUT_BYTES_BUDGET,
        ));
    }
    if !bounds.is_multiple_of(MESHLET_BOUNDS_STRIDE) {
        return Err(DagError::overflow("Meshlet bounds layout is misaligned."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::IndexedGeometry;

    fn triangle_grid(triangles: usize) -> IndexedGeometry {
        // 一串共享一条边的退化安全三角形(独立顶点,便于触发顶点上限)。
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for t in 0..triangles {
            let base = (t * 3) as u32;
            positions.extend_from_slice(&[t as f32, 0.0, 0.0, t as f32 + 1.0, 0.0, 0.0, t as f32, 1.0, 0.0]);
            indices.extend_from_slice(&[base, base + 1, base + 2]);
        }
        IndexedGeometry { positions, indices }
    }

    #[test]
    fn empty_mesh_yields_zero_meshlets() {
        let g = IndexedGeometry { positions: vec![], indices: vec![] };
        let r = build_meshlets(&g, None, None).expect("empty ok");
        assert_eq!(r.meshlet_count, 0);
        assert!(r.descriptors.is_empty());
        assert!(r.bounds.is_empty());
    }

    #[test]
    fn single_triangle_single_meshlet() {
        let g = triangle_grid(1);
        let r = build_meshlets(&g, None, None).expect("build");
        assert_eq!(r.meshlet_count, 1);
        assert_eq!(r.descriptors, [0, 3, 0, 1]);
        assert_eq!(r.vertex_remap, [0, 1, 2]);
        assert_eq!(r.local_triangle_indices, [(1 << 8) | 2 << 16]);
    }

    #[test]
    fn flushes_on_triangle_limit() {
        // 独立顶点网格下 maxVertices=64 先触发(每簇 21 三角形);把 maxTriangles 压到 4,
        // 使三角形上限成为约束,验证 flush-on-triangle-limit 路径本身。
        let g = triangle_grid(200);
        let r = build_meshlets(&g, None, Some(4)).expect("build");
        assert_eq!(r.source_triangle_count, 200);
        let counts: Vec<u32> = (0..r.meshlet_count).map(|i| r.descriptors[i * 4 + 3]).collect();
        assert_eq!(counts.first(), Some(&4));
        assert_eq!(counts.last(), Some(&4)); // 200 % 4 == 0,批批打满
        assert_eq!(counts.iter().sum::<u32>(), 200);
        assert_eq!(r.meshlet_count, 50);
    }

    #[test]
    fn flushes_on_vertex_limit_with_independent_vertices() {
        // 每三角形 3 个独立顶点:顶点上限 64 → 每簇 21 三角形(63 顶点,第 22 个超限)。
        let g = triangle_grid(200);
        let r = build_meshlets(&g, Some(64), Some(64)).expect("build");
        let vertex_counts: Vec<u32> = (0..r.meshlet_count).map(|i| r.descriptors[i * 4 + 1]).collect();
        assert!(vertex_counts.iter().all(|&c| c <= 64));
        let tri_counts: Vec<u32> = (0..r.meshlet_count).map(|i| r.descriptors[i * 4 + 3]).collect();
        assert_eq!(tri_counts.iter().sum::<u32>(), 200);
        assert!(tri_counts.iter().all(|&c| c <= 21), "independent-vertex grid caps at 21 tris/cluster, got {tri_counts:?}");
    }

    #[test]
    fn flushes_on_vertex_limit() {
        // 每三角形 3 个独立顶点,maxVertices=8 → 每 2 个三角形 flush(6 顶点,第 3 个到 9)。
        let g = triangle_grid(10);
        let r = build_meshlets(&g, Some(8), Some(64)).expect("build");
        let counts: Vec<u32> = (0..r.meshlet_count).map(|i| r.descriptors[i * 4 + 1]).collect();
        assert!(counts.iter().all(|&c| c <= 8));
        let tri_counts: Vec<u32> = (0..r.meshlet_count).map(|i| r.descriptors[i * 4 + 3]).collect();
        assert_eq!(tri_counts.iter().sum::<u32>(), 10);
        assert!(tri_counts.iter().all(|&c| c == 2), "expect 2 tris per cluster, got {tri_counts:?}");
        assert_eq!(r.meshlet_count, 5);
    }

    #[test]
    fn duplicate_vertices_share_local_index() {
        // 两个三角形共享全部顶点(重合三角形):同一 meshlet 内局部索引复用。
        let g = IndexedGeometry {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            indices: vec![0, 1, 2, 0, 1, 2],
        };
        let r = build_meshlets(&g, None, None).expect("build");
        assert_eq!(r.meshlet_count, 1);
        assert_eq!(r.descriptors, [0, 3, 0, 2]); // 3 顶点 2 三角形
    }

    #[test]
    fn degenerate_triangle_disables_cone() {
        // 共线三角形:法向锥必须禁用(cutoff = -1),包围体仍输出。
        let g = IndexedGeometry {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0],
            indices: vec![0, 1, 2],
        };
        let r = build_meshlets(&g, None, None).expect("build");
        assert_eq!(r.meshlet_count, 1);
        let cone = &r.bounds[12..16];
        assert_eq!(cone, [0.0, 0.0, 1.0, -1.0]);
    }

    #[test]
    fn cluster_output_spans_prefix_sum() {
        let g = triangle_grid(200);
        let r = build_meshlets(&g, None, Some(64)).expect("build");
        let spans = r.cluster_output_spans();
        assert_eq!(spans.len(), r.meshlet_count * 2);
        assert_eq!(spans[0], 0);
        for i in 1..r.meshlet_count {
            assert_eq!(spans[i * 2], spans[i * 2 - 1]);
        }
        assert_eq!(spans.last(), Some(&200));
    }
}
