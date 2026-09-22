//! RayBackend 合同的 Native 侧镜像（波次4/5 前置）。
//! 与 TS 侧 `packages/deep-engine/src/rayTracing/`（rayBackendTypes/bvhBuilder/rayTrace）
//! 逐语义对齐：中位数分裂 BVH（含 rightChild 显式链接）、Möller–Trumbore、栈式遍历。
//! 对拍纪律同 identityGolden：同输入下 TS 与 Native 的节点布局与 trace 输出必须一致。

/// 单节点 32 字节对齐布局与 TS BvhNode 一致：bounds 4×f32 不适用——本结构按 f32 八元组
/// + meta 三元组语义存放（WGSL storage 布局的 Rust 镜像，序列化层另行映射）。
#[derive(Debug, Clone, PartialEq)]
pub struct BvhNode {
    /// 叶子：三角形起始（order 数组下标）；内部：左子节点索引。
    pub left_first: u32,
    /// 叶子：三角形数量；内部：0。
    pub count: u32,
    /// 内部节点：右子节点索引（递归构建中与 left_first 不相邻）。
    pub right_child: u32,
    pub min_x: f32,
    pub min_y: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_y: f32,
    pub max_z: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BvhBuildResult {
    pub nodes: Vec<BvhNode>,
    /// 重排后的三角形索引（indices 下标）。
    pub order: Vec<u32>,
}

pub const MAX_BLAS_TRIANGLES: u32 = 4_194_304;

/// 构建失败原因（fail-closed；TS 侧以异常表达，Native 用 Result）。
#[derive(Debug, Clone, PartialEq)]
pub enum BvhBuildError {
    EmptyGeometry,
    IndexOutOfRange { index: u32, vertices: u32 },
    BudgetExceeded { triangles: u32 },
}

/// 中位数分裂构建：按质心最长轴二分，叶子 ≤4 三角；同输入产生逐位相同的节点数组。
pub fn build_bvh(vertices: &[f32], indices: &[u32]) -> Result<BvhBuildResult, BvhBuildError> {
    if !vertices.len().is_multiple_of(3) || !indices.len().is_multiple_of(3) {
        return Err(BvhBuildError::EmptyGeometry);
    }
    let triangles = (indices.len() / 3) as u32;
    if triangles == 0 {
        return Ok(BvhBuildResult {
            nodes: Vec::new(),
            order: Vec::new(),
        });
    }
    if triangles > MAX_BLAS_TRIANGLES {
        return Err(BvhBuildError::BudgetExceeded { triangles });
    }
    for &index in indices {
        let base = index.checked_mul(3).ok_or(BvhBuildError::IndexOutOfRange {
            index,
            vertices: vertices.len() as u32,
        })?;
        if base as usize + 2 >= vertices.len() {
            return Err(BvhBuildError::IndexOutOfRange {
                index,
                vertices: vertices.len() as u32,
            });
        }
    }

    let centroid = |triangle: u32| -> (f32, f32, f32) {
        // 三个角各取自己的顶点索引（corner 偏移是索引维度，不是 float 偏移）。
        let mut sum = [0.0f32; 3];
        for corner in 0..3u32 {
            let base = indices[triangle as usize * 3 + corner as usize] as usize * 3;
            for axis in 0..3 {
                sum[axis] += vertices[base + axis];
            }
        }
        (sum[0] / 3.0, sum[1] / 3.0, sum[2] / 3.0)
    };

    let mut nodes: Vec<BvhNode> = Vec::new();
    let mut order: Vec<u32> = (0..triangles).collect();

    // 每三角形的 bounds 缓存，避免重复扫描。
    let mut tri_bounds: Vec<[f32; 6]> = Vec::with_capacity(triangles as usize);
    for triangle in 0..triangles {
        let mut bounds = [
            f32::INFINITY,
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ];
        for corner in 0..3 {
            let base = indices[triangle as usize * 3 + corner] as usize * 3;
            for axis in 0..3 {
                let value = vertices[base + axis];
                bounds[axis] = bounds[axis].min(value);
                bounds[axis + 3] = bounds[axis + 3].max(value);
            }
        }
        tri_bounds.push(bounds);
    }

    fn recurse(
        nodes: &mut Vec<BvhNode>,
        order: &mut Vec<u32>,
        tri_bounds: &[[f32; 6]],
        centroids: &dyn Fn(u32) -> (f32, f32, f32),
        first: u32,
        count: u32,
    ) -> u32 {
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for slot in order[first as usize..(first + count) as usize].iter() {
            let bounds = &tri_bounds[*slot as usize];
            for axis in 0..3 {
                min[axis] = min[axis].min(bounds[axis]);
                max[axis] = max[axis].max(bounds[axis + 3]);
            }
        }
        let node_index = nodes.len() as u32;
        nodes.push(BvhNode {
            left_first: first,
            count,
            right_child: 0,
            min_x: min[0],
            min_y: min[1],
            min_z: min[2],
            max_x: max[0],
            max_y: max[1],
            max_z: max[2],
        });
        if count <= 4 {
            return node_index;
        }
        let extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        let axis = if extent[0] >= extent[1] && extent[0] >= extent[2] {
            0
        } else if extent[1] >= extent[2] {
            1
        } else {
            2
        };
        let center = (min[axis] + max[axis]) / 2.0;
        let mut left = first as i64;
        let mut right = (first + count - 1) as i64;
        while left <= right {
            let centroid = centroids(order[left as usize]);
            // 与 TS 一致：只按分割轴的质心分量比较；混入其它轴会破坏平衡（golden 对拍抓过）。
            let value = [centroid.0, centroid.1, centroid.2][axis];
            if value < center {
                left += 1;
                continue;
            }
            order.swap(left as usize, right as usize);
            right -= 1;
        }
        let left_count = ((left - first as i64).max(1).min(count as i64 - 1)) as u32;
        let left_index = recurse(nodes, order, tri_bounds, centroids, first, left_count);
        let right_index = recurse(
            nodes,
            order,
            tri_bounds,
            centroids,
            first + left_count,
            count - left_count,
        );
        let node = &mut nodes[node_index as usize];
        node.left_first = left_index;
        node.right_child = right_index;
        node.count = 0;
        node_index
    }

    recurse(&mut nodes, &mut order, &tri_bounds, &centroid, 0, triangles);
    Ok(BvhBuildResult { nodes, order })
}

/// Möller–Trumbore；返回 t 或 None。f32 语义与 TS 侧 intersectTriangle 一致。
pub fn intersect_triangle(
    origin: [f32; 3],
    direction: [f32; 3],
    vertices: &[f32],
    i0: u32,
    i1: u32,
    i2: u32,
) -> Option<f32> {
    let vertex = |i: u32| {
        [
            vertices[i as usize * 3],
            vertices[i as usize * 3 + 1],
            vertices[i as usize * 3 + 2],
        ]
    };
    let v0 = vertex(i0);
    let v1 = vertex(i1);
    let v2 = vertex(i2);
    let e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    let e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    let p = [
        direction[1] * e2[2] - direction[2] * e2[1],
        direction[2] * e2[0] - direction[0] * e2[2],
        direction[0] * e2[1] - direction[1] * e2[0],
    ];
    let det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if det.abs() < 1e-20 {
        return None;
    }
    let inv = 1.0 / det;
    let t = [origin[0] - v0[0], origin[1] - v0[1], origin[2] - v0[2]];
    let u = (t[0] * p[0] + t[1] * p[1] + t[2] * p[2]) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = [
        t[1] * e1[2] - t[2] * e1[1],
        t[2] * e1[0] - t[0] * e1[2],
        t[0] * e1[1] - t[1] * e1[0],
    ];
    let v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    Some((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv)
}

mod trace;
pub use trace::{
    TlasHit, TlasInstance, TraceHit, TraceQuery, trace_closest, trace_occluded, trace_tlas_closest,
};

#[cfg(test)]
mod bvh_tests;
#[cfg(test)]
mod trace_tests;
