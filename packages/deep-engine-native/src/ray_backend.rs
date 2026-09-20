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
    if vertices.len() % 3 != 0 || indices.len() % 3 != 0 {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_mesh(cells: u32) -> (Vec<f32>, Vec<u32>) {
        let stride = (cells + 1) as usize;
        let mut vertices = vec![0.0f32; stride * stride * 3];
        for y in 0..stride {
            for x in 0..stride {
                let base = (y * stride + x) * 3;
                vertices[base] = x as f32;
                vertices[base + 1] = y as f32;
                vertices[base + 2] = ((x as f32) * 13.7 + (y as f32) * 7.3).sin();
            }
        }
        let mut indices = Vec::new();
        for y in 0..cells as usize {
            for x in 0..cells as usize {
                let a = y * stride + x;
                let b = a + 1;
                let c = a + stride;
                let d = c + 1;
                indices.extend_from_slice(&[
                    a as u32, c as u32, b as u32, b as u32, c as u32, d as u32,
                ]);
            }
        }
        (vertices, indices)
    }

    #[test]
    fn builds_a_hierarchy_with_explicit_right_children() {
        let (vertices, indices) = grid_mesh(8);
        let built = build_bvh(&vertices, &indices).expect("build succeeds");
        assert!(built.nodes.len() > 1);
        let leaf_triangles: u32 = built.nodes.iter().map(|n| n.count).sum();
        assert_eq!(leaf_triangles as usize, indices.len() / 3);
        for node in &built.nodes {
            if node.count == 0 {
                assert!(node.right_child != 0 || built.nodes.len() == 1);
                assert!(node.right_child < built.nodes.len() as u32);
                assert!(node.left_first < built.nodes.len() as u32);
            }
        }
    }

    #[test]
    fn rejects_out_of_range_indices_fail_closed() {
        let err = build_bvh(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], &[0, 1, 7]);
        assert!(matches!(err, Err(BvhBuildError::IndexOutOfRange { .. })));
        // 与 TS 合同一致：空几何合法返回空结果；非整三角流才是错误。
        assert_eq!(
            build_bvh(&[], &[]),
            Ok(BvhBuildResult {
                nodes: Vec::new(),
                order: Vec::new()
            })
        );
        // 顶点流存在但索引越界：先报 IndexOutOfRange（与 TS validateRayBlas 同序）。
        let err = build_bvh(&[0.0, 0.0, 0.0], &[0, 1, 2]);
        assert!(matches!(err, Err(BvhBuildError::IndexOutOfRange { .. })));
    }

    #[test]
    fn matches_ts_golden_fixture() {
        // identityGolden：读取 TS buildBvh 生成的 fixture（generateBvhGolden.mts），
        // 节点布局与 order 逐值比对——任一侧构建语义漂移都会失败。
        let path = "../deep-engine/fixtures/rayTracing/bvh-golden.json";
        let raw = std::fs::read_to_string(path).expect("golden fixture readable");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("fixture parses");
        assert_eq!(parsed["schema"], "deep-monkey.bvh-golden.v1");
        // 输入顶点/索引直接取 fixture（两侧 sin/浮点实现不同，输入必须共享）。
        let vertices: Vec<f32> = parsed["vertices"]
            .as_array()
            .expect("vertices")
            .iter()
            .map(|value| value.as_f64().expect("vertex f64") as f32)
            .collect();
        let indices: Vec<u32> = parsed["indices"]
            .as_array()
            .expect("indices")
            .iter()
            .map(|value| value.as_u64().expect("index") as u32)
            .collect();
        let built = build_bvh(&vertices, &indices).expect("build succeeds");
        let nodes = parsed["nodes"].as_array().expect("nodes array");
        assert_eq!(
            built.nodes.len(),
            nodes.len(),
            "node count must match TS buildBvh"
        );
        for (node, expected) in built.nodes.iter().zip(nodes) {
            assert_eq!(
                node.left_first,
                expected["leftFirst"].as_u64().expect("leftFirst") as u32
            );
            assert_eq!(
                node.count,
                expected["count"].as_u64().expect("count") as u32
            );
            let right = expected.get("rightChild").and_then(|v| v.as_u64());
            if node.count == 0 {
                assert_eq!(
                    Some(node.right_child as u64),
                    right,
                    "rightChild must match"
                );
            } else {
                assert_eq!(right, None, "leaves carry no rightChild");
            }
            for (actual, key) in [
                (node.min_x, "minX"),
                (node.min_y, "minY"),
                (node.min_z, "minZ"),
                (node.max_x, "maxX"),
                (node.max_y, "maxY"),
                (node.max_z, "maxZ"),
            ] {
                let expected_value = expected[key].as_f64().expect(key) as f32;
                assert_eq!(
                    actual.to_bits(),
                    expected_value.to_bits(),
                    "bounds {key} must be bit-identical"
                );
            }
        }
        let order = parsed["order"].as_array().expect("order array");
        assert_eq!(built.order.len(), order.len());
        for (actual, expected) in built.order.iter().zip(order) {
            assert_eq!(*actual, expected.as_u64().expect("order entry") as u32);
        }
    }

    #[test]
    fn trace_matches_brute_force_across_a_ray_fan() {
        let (vertices, indices) = grid_mesh(8);
        let built = build_bvh(&vertices, &indices).expect("build succeeds");
        for step in 0..40u32 {
            let angle = step as f32 / 40.0 * std::f32::consts::TAU;
            for (ox, oy) in [(4.0f32, 4.0f32), (0.5, 0.5)] {
                let query = TraceQuery {
                    ox,
                    oy,
                    oz: 6.0,
                    dx: angle.cos(),
                    dy: angle.sin(),
                    dz: -1.0,
                    t_max: 64.0,
                };
                let traced = trace_closest(&vertices, &indices, &built, &query);
                let mut brute: Option<TraceHit> = None;
                for triangle in 0..(indices.len() / 3) as u32 {
                    if let Some(t) = intersect_triangle(
                        [query.ox, query.oy, query.oz],
                        [query.dx, query.dy, query.dz],
                        &vertices,
                        indices[triangle as usize * 3],
                        indices[triangle as usize * 3 + 1],
                        indices[triangle as usize * 3 + 2],
                    ) {
                        if t <= query.t_max && brute.as_ref().is_none_or(|hit| t < hit.t) {
                            brute = Some(TraceHit {
                                t,
                                primitive_index: triangle,
                            });
                        }
                    }
                }
                assert_eq!(traced, brute, "mismatch at step {step} origin ({ox},{oy})");
            }
        }
    }

    #[test]
    fn occlusion_and_miss_semantics_match_contract() {
        let (vertices, indices) = grid_mesh(4);
        let built = build_bvh(&vertices, &indices).expect("build succeeds");
        assert!(trace_occluded(
            &vertices,
            &indices,
            &built,
            &TraceQuery {
                ox: 2.0,
                oy: 2.0,
                oz: 4.0,
                dx: 0.0,
                dy: 0.0,
                dz: -1.0,
                t_max: 32.0
            }
        ));
        assert!(!trace_occluded(
            &vertices,
            &indices,
            &built,
            &TraceQuery {
                ox: 2.0,
                oy: 2.0,
                oz: 4.0,
                dx: 0.0,
                dy: 0.0,
                dz: 1.0,
                t_max: 32.0
            }
        ));
        assert!(
            trace_closest(
                &vertices,
                &indices,
                &built,
                &TraceQuery {
                    ox: 2.0,
                    oy: 2.0,
                    oz: 4.0,
                    dx: 0.0,
                    dy: 0.0,
                    dz: -1.0,
                    t_max: 0.5
                }
            )
            .is_none()
        );
    }

    #[test]
    fn moeller_trumbore_matches_expected_hit_and_parallel_rejection() {
        let vertices = vec![
            -1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0,
        ];
        assert_eq!(
            intersect_triangle([0.0, 0.0, 5.0], [0.0, 0.0, -1.0], &vertices, 0, 1, 2),
            Some(5.0)
        );
        assert_eq!(
            intersect_triangle([0.0, 0.0, 5.0], [1.0, 0.0, 0.0], &vertices, 0, 1, 2),
            None
        );
    }
}

/// 栈式遍历查询（与 TS rayTrace.ts TraceQuery 一致；方向长度即 t 的单位）。
pub struct TraceQuery {
    pub ox: f32,
    pub oy: f32,
    pub oz: f32,
    pub dx: f32,
    pub dy: f32,
    pub dz: f32,
    pub t_max: f32,
}

/// 最近命中：t 与全局三角索引（indices 下标）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TraceHit {
    pub t: f32,
    pub primitive_index: u32,
}

/// 栈式最近命中遍历。slab 测试对零分量轴显式包含判定（0*Inf=NaN 会错误剪掉整棵树，
/// 与 TS 侧修复同源）；无命中返回 None。
pub fn trace_closest(
    vertices: &[f32],
    indices: &[u32],
    built: &BvhBuildResult,
    query: &TraceQuery,
) -> Option<TraceHit> {
    if !(query.t_max > 0.0) || built.nodes.is_empty() {
        return None;
    }
    let inv = [1.0 / query.dx, 1.0 / query.dy, 1.0 / query.dz];
    let origin = [query.ox, query.oy, query.oz];
    let direction = [query.dx, query.dy, query.dz];
    let mut best: Option<TraceHit> = None;
    let mut stack = vec![0u32];
    while let Some(node_index) = stack.pop() {
        let node = &built.nodes[node_index as usize];
        let t_cap = best.as_ref().map_or(query.t_max, |hit| hit.t);
        if !overlaps_bounds(&origin, &direction, &inv, node, t_cap) {
            continue;
        }
        if node.count > 0 {
            for local in 0..node.count {
                let primitive_index = built.order[node.left_first as usize + local as usize];
                let i0 = indices[primitive_index as usize * 3];
                let i1 = indices[primitive_index as usize * 3 + 1];
                let i2 = indices[primitive_index as usize * 3 + 2];
                let t = intersect_triangle(origin, direction, vertices, i0, i1, i2);
                if let Some(t) = t {
                    if t <= query.t_max && best.as_ref().is_none_or(|hit| t < hit.t) {
                        best = Some(TraceHit { t, primitive_index });
                    }
                }
            }
            continue;
        }
        stack.push(node.right_child);
        stack.push(node.left_first);
    }
    best
}

/// 遮挡查询：任意命中即 true（早退语义经 closest 实现，合同与 TS traceOccluded 一致）。
pub fn trace_occluded(
    vertices: &[f32],
    indices: &[u32],
    built: &BvhBuildResult,
    query: &TraceQuery,
) -> bool {
    trace_closest(vertices, indices, built, query).is_some()
}

fn overlaps_bounds(
    origin: &[f32; 3],
    direction: &[f32; 3],
    inv: &[f32; 3],
    node: &BvhNode,
    t_max: f32,
) -> bool {
    let mins = [node.min_x, node.min_y, node.min_z];
    let maxs = [node.max_x, node.max_y, node.max_z];
    let mut entry = 0.0f32;
    let mut exit = t_max;
    for axis in 0..3 {
        if direction[axis] != 0.0 {
            let (mut t_near, mut t_far) = (
                (mins[axis] - origin[axis]) * inv[axis],
                (maxs[axis] - origin[axis]) * inv[axis],
            );
            if t_near > t_far {
                std::mem::swap(&mut t_near, &mut t_far);
            }
            if t_near > entry {
                entry = t_near;
            }
            if t_far < exit {
                exit = t_far;
            }
            if entry > exit {
                return false;
            }
        } else if origin[axis] < mins[axis] || origin[axis] > maxs[axis] {
            return false;
        }
    }
    entry <= exit
}
