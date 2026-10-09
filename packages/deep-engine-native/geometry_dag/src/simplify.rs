//! 确定性网格聚类简化:坐标量化到 cell,每 cell 均值代表点,退化/重复三角形剔除。
//!
//! 与 TS 权威实现(`packages/deep-engine/src/geometry/meshletDag.ts` 的
//! `clusterSimplify`)逐位对拍。确定性来自遍历序而非哈希序:
//! - cell key 为 `(i64,i64,i64)`(`Math.round(x)=floor(x+0.5)` 语义);
//! - 输出顶点序 = 源顶点序中 cell 首次出现序;
//! - 输出三角形序 = 源三角形序(去重保留首份)。
//!
//! 全部几何量在 f64 下运算后按 `as f32` 截断(TS Float32Array 语义)。

use crate::error::{DagError, DagResult};
use crate::types::rustc_hash_lite::{FxHashMap, FxHashSet};

/// cell key 上限(2^62):防病态输入下 `as i64` 饱和静默合并不同 cell。
const CELL_KEY_LIMIT: f64 = 4_611_686_018_427_387_904.0; // 2^62

/// 聚类简化结果(与 TS `ClusterSimplifyResult` 同构)。
#[derive(Debug, Clone)]
pub struct ClusterSimplifyResult {
    /// 代表点位置(f32,由 f64 均值截断)。
    pub positions: Vec<f32>,
    /// 简化后索引。
    pub indices: Vec<u32>,
    /// 每输出三角形 → 当前层输入三角形索引(父子归属用)。
    pub source_triangles: Vec<u32>,
    /// 顶点相对代表点的最大位移(世界单位,f64 真误差场)。
    pub max_displacement: f64,
}

/// TS 去重键的 Rust 形态:字符串 `${a}_${b}_${c}` 的排列组合在无分隔符歧义下
/// 与 `(u32,u32,u32)` 元组一一对应,故直接用元组承载。
/// 分支结构逐字对应 `meshletDag.ts` 的嵌套三元表达式(见 [`cluster_simplify`] 内注释)。
fn ts_dedup_key(a: u32, b: u32, c: u32) -> (u32, u32, u32) {
    if a < b {
        if b < c {
            (a, b, c)
        } else if a < c {
            (a, c, b)
        } else {
            (c, a, b)
        }
    } else if b < c {
        (b, c, a)
    } else if a < c {
        (b, a, c)
    } else {
        (c, b, a)
    }
}

/// 执行一轮聚类简化。`factor <= 1` 时原样返回(误差 0)。
///
/// # Errors
/// 量化坐标超出 i64 安全范围(病态数值跨度)时返回 [`DagError::Overflow`]。
pub fn cluster_simplify(
    positions: &[f32],
    indices: &[u32],
    factor: f64,
) -> DagResult<ClusterSimplifyResult> {
    if factor <= 1.0 {
        return Ok(ClusterSimplifyResult {
            positions: positions.to_vec(),
            indices: indices.to_vec(),
            source_triangles: (0..indices.len() as u32 / 3).collect(),
            max_displacement: 0.0,
        });
    }

    // 源包围盒(f64 精度读取 f32 值)。
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for tri in positions.chunks_exact(3) {
        for (axis, &value) in tri.iter().enumerate() {
            let value = f64::from(value);
            min[axis] = min[axis].min(value);
            max[axis] = max[axis].max(value);
        }
    }
    // JS `Math.max(...) || 1`:0 与 NaN 都回退为 1。
    let extent_raw = (max[0] - min[0]).max((max[1] - min[1]).max(max[2] - min[2]));
    let extent = if extent_raw == 0.0 || extent_raw.is_nan() {
        1.0
    } else {
        extent_raw
    };
    let cell = extent / f64::max(4.0, 24.0 / factor);

    let cell_of = |x: f64, y: f64, z: f64| -> DagResult<(i64, i64, i64)> {
        let quantize = |v: f64| -> DagResult<i64> {
            // JS Math.round(v) = floor(v + 0.5)。
            let rounded = (v + 0.5).floor();
            if !rounded.is_finite() || rounded.abs() >= CELL_KEY_LIMIT {
                return Err(DagError::overflow(
                    "cluster cell coordinate exceeds addressable range (degenerate cell size?)",
                ));
            }
            Ok(rounded as i64)
        };
        Ok((
            quantize((x - min[0]) / cell)?,
            quantize((y - min[1]) / cell)?,
            quantize((z - min[2]) / cell)?,
        ))
    };

    // 第一遍:每 cell 聚合均值代表点。
    let mut rep: FxHashMap<(i64, i64, i64), [f64; 4]> = FxHashMap::default();
    for tri in positions.chunks_exact(3) {
        let key = cell_of(f64::from(tri[0]), f64::from(tri[1]), f64::from(tri[2]))?;
        let bucket = rep.entry(key).or_insert([0.0; 4]);
        bucket[0] += f64::from(tri[0]);
        bucket[1] += f64::from(tri[1]);
        bucket[2] += f64::from(tri[2]);
        bucket[3] += 1.0;
    }

    // 第二遍:全网格最大位移(真误差场)。
    let mut max_displacement = 0.0f64;
    for tri in positions.chunks_exact(3) {
        let key = cell_of(f64::from(tri[0]), f64::from(tri[1]), f64::from(tri[2]))?;
        if let Some(bucket) = rep.get(&key) {
            if bucket[3] == 0.0 {
                continue;
            }
            let dx = f64::from(tri[0]) - bucket[0] / bucket[3];
            let dy = f64::from(tri[1]) - bucket[1] / bucket[3];
            let dz = f64::from(tri[2]) - bucket[2] / bucket[3];
            max_displacement = max_displacement.max(crate::bounds::hypot3(dx, dy, dz));
        }
    }

    // 第三遍:输出顶点表(源顶点序中 cell 首次出现序)。
    // TS 语义关键点:JS 侧第四遍的面积计算读的是 f64 的 number 数组(未截断),
    // `Float32Array.from` 只发生在函数返回时。因此这里同时维护 f64 表(判定用)
    // 与 f32 表(返回用),两者必须在代表点上一致。
    let mut out_positions: Vec<f32> = Vec::new();
    let mut out_positions_f64: Vec<f64> = Vec::new();
    let mut cell_index: FxHashMap<(i64, i64, i64), u32> = FxHashMap::default();
    let mut remap: FxHashMap<u32, u32> = FxHashMap::default();
    for (vertex, tri) in positions.chunks_exact(3).enumerate() {
        let key = cell_of(f64::from(tri[0]), f64::from(tri[1]), f64::from(tri[2]))?;
        let local = *cell_index.entry(key).or_insert_with(|| {
            let bucket = &rep[&key];
            // TS 语义:local = outPositions.length / 3(顶点号,不是元素槽位)。
            let local = (out_positions.len() / 3) as u32;
            let (rx, ry, rz) = (
                bucket[0] / bucket[3],
                bucket[1] / bucket[3],
                bucket[2] / bucket[3],
            );
            out_positions_f64.extend_from_slice(&[rx, ry, rz]);
            out_positions.push(rx as f32);
            out_positions.push(ry as f32);
            out_positions.push(rz as f32);
            local
        });
        remap.insert(vertex as u32, local);
    }

    // 第四遍:三角形重映射 + 退化剔除 + 排序键去重(面积判定用 f64 代表点,见上)。
    let mut out_indices: Vec<u32> = Vec::new();
    let mut source_triangles: Vec<u32> = Vec::new();
    let mut seen: FxHashSet<(u32, u32, u32)> = FxHashSet::default();
    for (source, face) in indices.chunks_exact(3).enumerate() {
        let a = remap[&face[0]];
        let b = remap[&face[1]];
        let c = remap[&face[2]];
        let (ax, ay, az) = (
            out_positions_f64[a as usize * 3],
            out_positions_f64[a as usize * 3 + 1],
            out_positions_f64[a as usize * 3 + 2],
        );
        let (bx, by, bz) = (
            out_positions_f64[b as usize * 3],
            out_positions_f64[b as usize * 3 + 1],
            out_positions_f64[b as usize * 3 + 2],
        );
        let (cx, cy, cz) = (
            out_positions_f64[c as usize * 3],
            out_positions_f64[c as usize * 3 + 1],
            out_positions_f64[c as usize * 3 + 2],
        );
        let (e1x, e1y, e1z) = (bx - ax, by - ay, bz - az);
        let (e2x, e2y, e2z) = (cx - ax, cy - ay, cz - az);
        let n1 = e1y * e2z - e1z * e2y;
        let n2 = e1z * e2x - e1x * e2z;
        let n3 = e1x * e2y - e1y * e2x;
        let area2 = n1 * n1 + n2 * n2 + n3 * n3;
        if a == b || b == c || a == c || area2 <= 1e-24 {
            #[cfg(feature = "dbg_dropped")]
            eprintln!(
                "RUST drop face {source}: a={a} b={b} c={c} area2={area2:e} degenerateVtx={}",
                a == b || b == c || a == c
            );
            continue; // 聚类合并出的退化/共线三角形剔除
        }
        #[cfg(feature = "dbg_dropped")]
        if seen.contains(&ts_dedup_key(a, b, c)) {
            eprintln!(
                "RUST drop face {source}: dup key {:?}",
                ts_dedup_key(a, b, c)
            );
        }
        // 去重键 = TS 字符串键的元组形态(生成逻辑见下方 ts_dedup_key 文档)。
        let key = ts_dedup_key(a, b, c);
        // TS `!(a<b) && b<c` 分支无条件给 `${b}_${c}_${a}`,当 a<c 时这不是排序序
        // (例: (242,240,274) → "240_274_242" vs (274,240,242) → "240_242_274",
        // 两者排序后同键但字符串不同)——权威 golden 的去重行为因此与"排序键去重"
        // 不同,这里必须保持逐字一致,不得"修正"为完美排序。
        if !seen.insert(key) {
            continue; // 不同源三角形塌成同一目标三角形时只保留一份
        }
        #[cfg(feature = "dbg_dropped")]
        eprintln!("RUST keep face {source}: key {a}_{b}_{c} dgcKey={key:?}");
        source_triangles.push(source as u32);
        out_indices.extend_from_slice(&[a, b, c]);
    }

    Ok(ClusterSimplifyResult {
        positions: out_positions,
        indices: out_indices,
        source_triangles,
        max_displacement,
    })
}

/// 测试专用:确定性经纬球网格(与 TS 单测的 sphereGeometry 同构,无 jitter)。
#[cfg(test)]
pub(crate) mod test_support {
    /// 生成经纬细分球(顶点序:ring 主序、segment 次序;三角形:上半/下半各一)。
    pub(crate) fn test_sphere(segments: usize, rings: usize) -> (Vec<f32>, Vec<u32>) {
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for r in 0..=rings {
            let phi = (r as f64 / rings as f64) * std::f64::consts::PI;
            for s in 0..=segments {
                let theta = (s as f64 / segments as f64) * std::f64::consts::PI * 2.0;
                positions.push((phi.sin() * theta.cos()) as f32);
                positions.push(phi.cos() as f32);
                positions.push((phi.sin() * theta.sin()) as f32);
            }
        }
        let row = segments + 1;
        for r in 0..rings {
            for s in 0..segments {
                let a = (r * row + s) as u32;
                let b = a + 1;
                let c = a + row as u32;
                let d = c + 1;
                if r > 0 {
                    indices.extend_from_slice(&[a, c, b]);
                }
                if r < rings - 1 {
                    indices.extend_from_slice(&[b, c, d]);
                }
            }
        }
        (positions, indices)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::test_sphere;
    use super::*;

    #[test]
    fn factor_le_one_is_identity() {
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let indices = vec![0, 1, 2];
        let r = cluster_simplify(&positions, &indices, 1.0).expect("identity");
        assert_eq!(r.positions, positions);
        assert_eq!(r.indices, indices);
        assert_eq!(r.source_triangles, [0]);
        assert_eq!(r.max_displacement, 0.0);
    }

    #[test]
    fn degenerate_faces_are_dropped() {
        // 共线三角形 + 重合顶点三角形:全部剔除。
        let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0];
        let indices = vec![0, 1, 2, 0, 1, 2];
        let r = cluster_simplify(&positions, &indices, 2.0).expect("simplify");
        assert!(r.indices.is_empty());
        assert!(r.source_triangles.is_empty());
    }

    #[test]
    fn merging_cells_dedup_follows_ts_key_quirk() {
        // TS 键的 quirk 实证:(0,1,2)→(0,1,2)、(0,2,3)→(0,2,3)、(1,0,2)→(0,2,1),
        // 三键互不相同 → 三面全保留(完美排序键下第三面会与第一面撞键被剔)。
        let positions = vec![
            0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
        ];
        let indices = vec![0, 1, 2, 0, 2, 3, 1, 0, 2];
        let r = cluster_simplify(&positions, &indices, 2.0).expect("simplify");
        assert_eq!(
            r.indices.len() / 3,
            3,
            "TS quirk keys differ for all three faces"
        );
        assert_eq!(r.source_triangles, [0, 1, 2]);
        // 同键重复 (0,1,2)/(0,1,2) 仍然去重:键同 → 只留首份。
        let indices = vec![0, 1, 2, 0, 1, 2];
        let r = cluster_simplify(&positions, &indices, 2.0).expect("simplify");
        assert_eq!(r.indices.len() / 3, 1);
        assert_eq!(r.source_triangles, [0]);
    }

    #[test]
    fn ts_dedup_key_matches_ts_string_semantics() {
        // 每个 case 的期望 = TS 模板串逐字求值(非排序序)。
        assert_eq!(ts_dedup_key(1, 2, 3), (1, 2, 3)); // a<b,b<c: "1_2_3"
        assert_eq!(ts_dedup_key(1, 3, 2), (1, 2, 3)); // a<b,!(b<c),a<c: "1_2_3"
        assert_eq!(ts_dedup_key(3, 1, 2), (1, 2, 3)); // !(a<b),b<c: "1_2_3"
        assert_eq!(ts_dedup_key(2, 1, 3), (1, 3, 2)); // !(a<b),b<c: "1_3_2"
        assert_eq!(ts_dedup_key(2, 3, 1), (1, 2, 3)); // a<b,!(b<c),!(a<c): "1_2_3"
        assert_eq!(ts_dedup_key(3, 2, 1), (1, 2, 3)); // !(a<b),!(b<c),!(a<c): "1_2_3"
        assert_eq!(ts_dedup_key(242, 240, 274), (240, 274, 242)); // golden 实证 quirk 面
        assert_eq!(ts_dedup_key(274, 240, 242), (240, 242, 274)); // 同排序不同键 → 不去重
    }

    #[test]
    fn dedup_picks_the_earliest_source_triangle() {
        // 两个全等三角形(不同源)只留一份,source 指向最早出现的。
        let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let indices = vec![0, 1, 2, 0, 1, 2];
        let r = cluster_simplify(&positions, &indices, 2.0).expect("simplify");
        assert_eq!(r.indices.len() / 3, 1);
        assert_eq!(r.source_triangles, [0]);
    }

    #[test]
    fn empty_mesh_is_safe() {
        let r = cluster_simplify(&[], &[], 2.0).expect("empty");
        assert!(r.positions.is_empty());
        assert_eq!(r.max_displacement, 0.0);
    }

    #[test]
    fn error_field_tracks_displacement() {
        // 细分球上 factor=2 的位移必为正。
        let (positions, indices) = test_sphere(24, 12);
        let r = cluster_simplify(&positions, &indices, 2.0).expect("simplify");
        assert!(r.max_displacement > 0.0);
        assert!(
            r.indices.len() / 3 < indices.len() / 3,
            "cluster must reduce triangles"
        );
    }
}
