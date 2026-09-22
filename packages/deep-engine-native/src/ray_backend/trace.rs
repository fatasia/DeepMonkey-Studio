use super::{BvhBuildResult, BvhNode, intersect_triangle};

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
    if query.t_max <= 0.0 || built.nodes.is_empty() {
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
                if let Some(t) = t
                    && t <= query.t_max
                    && best.as_ref().is_none_or(|hit| t < hit.t)
                {
                    best = Some(TraceHit { t, primitive_index });
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

/// TLAS 实例描述：world→local 仿射（行主序 3x4）+ 掩码。
#[derive(Debug, Clone)]
pub struct TlasInstance {
    pub id: u32,
    pub blas_vertices: std::rc::Rc<Vec<f32>>,
    pub blas_indices: std::rc::Rc<Vec<u32>>,
    pub blas: BvhBuildResult,
    pub world_to_local: [f32; 12],
    pub mask: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TlasHit {
    pub t: f32,
    pub primitive_index: u32,
    pub instance_id: u32,
}

fn apply(m: &[f32; 12], p: [f32; 3]) -> [f32; 3] {
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
}

fn apply_direction(m: &[f32; 12], d: [f32; 3]) -> [f32; 3] {
    [
        m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
        m[4] * d[0] + m[5] * d[1] + m[6] * d[2],
        m[8] * d[0] + m[9] * d[1] + m[10] * d[2],
    ]
}

/// 两级最近命中：逐实例（mask 过滤）逆变换到局部后走 trace_closest，取全局最近 t。
/// 实例级 TLAS BVH（实例盒的构建）与 WGSL 扩展同属后续切片；本合同先保证语义正确性。
pub fn trace_tlas_closest(
    instances: &[TlasInstance],
    query: &TraceQuery,
    mask: u32,
) -> Option<TlasHit> {
    if query.t_max <= 0.0 {
        return None;
    }
    let origin = [query.ox, query.oy, query.oz];
    let direction = [query.dx, query.dy, query.dz];
    let mut best: Option<TlasHit> = None;
    for instance in instances {
        if instance.mask & mask == 0 {
            continue;
        }
        let local_origin = apply(&instance.world_to_local, origin);
        let local_direction = apply_direction(&instance.world_to_local, direction);
        let scale = (local_direction[0] * local_direction[0]
            + local_direction[1] * local_direction[1]
            + local_direction[2] * local_direction[2])
            .sqrt();
        if scale <= 0.0 {
            continue;
        }
        let local_query = TraceQuery {
            ox: local_origin[0],
            oy: local_origin[1],
            oz: local_origin[2],
            dx: local_direction[0] / scale,
            dy: local_direction[1] / scale,
            dz: local_direction[2] / scale,
            t_max: query.t_max * scale,
        };
        let hit = trace_closest(
            &instance.blas_vertices,
            &instance.blas_indices,
            &instance.blas,
            &local_query,
        );
        if let Some(hit) = hit {
            let world_t = hit.t / scale;
            if world_t <= query.t_max && best.as_ref().is_none_or(|best| world_t < best.t) {
                best = Some(TlasHit {
                    t: world_t,
                    primitive_index: hit.primitive_index,
                    instance_id: instance.id,
                });
            }
        }
    }
    best
}
