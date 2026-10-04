//! 簇包围球 / AABB / 法向锥计算。
//!
//! 与 TS 权威实现(`packages/deep-engine/src/geometry/meshletBounds.ts`)逐位对拍:
//! TS 中 `Float32Array` 元素读出即 f64,全部运算在 f64 下进行,写回时经 `Math.fround`
//! (round-to-nearest-even 的 f64→f32)。Rust 侧对应:f32 读入 `as f64` 提升、f64 运算、
//! 写回 `as f32`。相邻 f32(ulp 步进)用位操作复刻 TS 的 `ADJACENT_WORDS` 技巧。

use crate::error::{DagError, DagResult};

/// 单个簇的渲染剔除包围体。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeshletBounds {
    /// 包围球 `[cx, cy, cz, r]`,半径为保守 f32(向上含 1 ulp 余量)。
    pub sphere: [f32; 4],
    /// AABB 最小角点。
    pub aabb_min: [f32; 3],
    /// AABB 最大角点。
    pub aabb_max: [f32; 3],
    /// 法向锥 `[nx, ny, nz, cutoff]`;cutoff 为 -1 表示锥剔除禁用。
    pub cone: [f32; 4],
}

impl MeshletBounds {
    /// 平铺为 16 个 f32(与 TS `appendBounds` 顺序一致:sphere, aabbMin+0, aabbMax+0, cone)。
    #[must_use]
    pub fn to_flat(&self) -> [f32; 16] {
        [
            self.sphere[0], self.sphere[1], self.sphere[2], self.sphere[3],
            self.aabb_min[0], self.aabb_min[1], self.aabb_min[2], 0.0,
            self.aabb_max[0], self.aabb_max[1], self.aabb_max[2], 0.0,
            self.cone[0], self.cone[1], self.cone[2], self.cone[3],
        ]
    }
}

/// 三角形单位法线;退化(重合顶点或近共线)返回 `None`。
///
/// 与 TS `triangleNormal` 一致:全部在 f64 下计算,`length <= scale²·1e-12` 判退化。
#[must_use]
pub fn triangle_normal(positions: &[f32], a: u32, b: u32, c: u32) -> Option<[f64; 3]> {
    let (ao, bo, co) = (a as usize * 3, b as usize * 3, c as usize * 3);
    let ax = f64::from(positions[ao]);
    let ay = f64::from(positions[ao + 1]);
    let az = f64::from(positions[ao + 2]);
    let ab = [
        f64::from(positions[bo]) - ax,
        f64::from(positions[bo + 1]) - ay,
        f64::from(positions[bo + 2]) - az,
    ];
    let ac = [
        f64::from(positions[co]) - ax,
        f64::from(positions[co + 1]) - ay,
        f64::from(positions[co + 2]) - az,
    ];
    let cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    let length = hypot3(cross[0], cross[1], cross[2]);
    let scale = f64::max(hypot2(ab[0], ab[1]), hypot2(ac[0], ac[1]));
    if !length.is_finite() || length <= scale * scale * 1e-12 {
        return None;
    }
    Some([cross[0] / length, cross[1] / length, cross[2] / length])
}

/// 计算簇包围体。`vertices` 为全局顶点表(与 TS `pending.vertices` 同序)。
///
/// # Errors
/// 包围球半径无法表示为有限 f32 时返回 [`DagError::Overflow`]。
pub fn compute_meshlet_bounds(
    positions: &[f32],
    vertices: &[u32],
    triangle_normals: &[[f64; 3]],
    has_degenerate_triangle: bool,
) -> DagResult<MeshletBounds> {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for &vertex in vertices {
        let offset = vertex as usize * 3;
        for (axis, value) in positions[offset..offset + 3].iter().enumerate() {
            let value = f64::from(*value);
            min[axis] = min[axis].min(value);
            max[axis] = max[axis].max(value);
        }
    }
    let center: [f32; 3] = [
        ((min[0] + max[0]) * 0.5) as f32,
        ((min[1] + max[1]) * 0.5) as f32,
        ((min[2] + max[2]) * 0.5) as f32,
    ];
    let mut radius = 0.0f64;
    for &vertex in vertices {
        let offset = vertex as usize * 3;
        let dx = f64::from(positions[offset]) - f64::from(center[0]);
        let dy = f64::from(positions[offset + 1]) - f64::from(center[1]);
        let dz = f64::from(positions[offset + 2]) - f64::from(center[2]);
        radius = radius.max(hypot3(dx, dy, dz));
    }
    let conservative_radius = next_float32(radius);
    if !conservative_radius.is_finite() {
        return Err(DagError::overflow(
            "Meshlet sphere cannot be represented by finite float32 bounds.",
        ));
    }
    let cone = compute_normal_cone(triangle_normals, has_degenerate_triangle);
    Ok(MeshletBounds {
        sphere: [center[0], center[1], center[2], conservative_radius],
        aabb_min: [min[0] as f32, min[1] as f32, min[2] as f32],
        aabb_max: [max[0] as f32, max[1] as f32, max[2] as f32],
        cone,
    })
}

/// f32 邻域步进:与 TS `adjacentFloat32` 一致(位操作 ±1 ulp;零值走向最小次正规数)。
fn adjacent_float32(value: f32, direction: i32) -> f32 {
    if value == 0.0 {
        return if direction > 0 { f32::from_bits(1) } else { f32::from_bits(1).copysign(-1.0) };
    }
    let bits = value.to_bits();
    let next = if (value > 0.0) == (direction > 0) { bits + 1 } else { bits - 1 };
    f32::from_bits(next)
}

/// TS `nextFloat32`:fround 后若已 ≥ 原值则用之,否则向上 1 ulp。
pub(crate) fn next_float32(value: f64) -> f32 {
    let rounded = value as f32;
    if !rounded.is_finite() || f64::from(rounded) >= value {
        return rounded;
    }
    adjacent_float32(rounded, 1)
}

/// TS `previousFloat32`:fround 后向下 1 ulp。
fn previous_float32(value: f64) -> f32 {
    adjacent_float32(value as f32, -1)
}

/// 法向锥:非退化三角形单位法线的和归一化,`cutoff = min(1, min(axis·n))`(向下 1 ulp 保守)。
fn compute_normal_cone(normals: &[[f64; 3]], disabled: bool) -> [f32; 4] {
    if disabled || normals.is_empty() {
        return [0.0, 0.0, 1.0, -1.0];
    }
    let mut sum = [0.0f64; 3];
    for normal in normals {
        sum[0] += normal[0];
        sum[1] += normal[1];
        sum[2] += normal[2];
    }
    let length = hypot3(sum[0], sum[1], sum[2]);
    if length <= 1e-12 {
        return [0.0, 0.0, 1.0, -1.0];
    }
    let axis: [f32; 3] = [
        (sum[0] / length) as f32,
        (sum[1] / length) as f32,
        (sum[2] / length) as f32,
    ];
    let mut cutoff = 1.0f64;
    for normal in normals {
        let dot = f64::from(axis[0]) * normal[0]
            + f64::from(axis[1]) * normal[1]
            + f64::from(axis[2]) * normal[2];
        cutoff = cutoff.min(dot);
    }
    if cutoff <= 0.0 {
        return [axis[0], axis[1], axis[2], -1.0];
    }
    [axis[0], axis[1], axis[2], previous_float32(cutoff.min(1.0))]
}

/// V8 `Math.hypot` 的逐位复刻(`src/builtins/math.tq` MathHypot):
/// 取绝对值最大值做缩放,平 f64 方和,再正确舍入 `sqrt`。
///
/// 与嵌套 `hypot2(hypot2(x,y),z)` 不同,该算法对 f64 的舍入路径是确定的;
/// 法向锥轴这类和值恰好跨零的临界点上,任何 1 ulp 偏差都会翻转结果符号,
/// golden 对拍(quick_sphere 逐位过、synthetic50k 曾因此单字段翻符号)已实证。
#[inline]
#[must_use]
pub fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    js_hypot(&[x, y, z])
}

/// V8 `Math.hypot(x, y)` 双参数形态(同一 MathHypot 算法)。
#[inline]
#[must_use]
pub fn hypot2(x: f64, y: f64) -> f64 {
    js_hypot(&[x, y])
}

/// V8 MathHypot builtin 的确定性算法:max 缩放 + Σ(x/max)² + sqrt。
#[inline]
fn js_hypot(args: &[f64]) -> f64 {
    let mut max = 0.0f64;
    for &value in args {
        if value.is_infinite() {
            return f64::INFINITY;
        }
        max = if max < value.abs() { value.abs() } else { max };
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    for &value in args {
        let scaled = value / max;
        sum += scaled * scaled;
    }
    max * sum.sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjacent_float32_steps_one_ulp() {
        let one = 1.0f32;
        assert_eq!(adjacent_float32(one, 1).to_bits(), one.to_bits() + 1);
        assert_eq!(adjacent_float32(one, -1).to_bits(), one.to_bits() - 1);
        // 零值:走向最小次正规数
        assert_eq!(adjacent_float32(0.0, 1), f32::from_bits(1));
        assert_eq!(adjacent_float32(0.0, -1), -f32::from_bits(1));
        // 最大正数向上溢出为无穷(TS 同语义:bits+1 翻到 Inf 编码)
        assert!(adjacent_float32(f32::MAX, 1).is_infinite());
    }

    #[test]
    fn next_float32_conservative_rounding() {
        // 整数可精确表示:直接用 rounded
        assert_eq!(next_float32(2.0), 2.0f32);
        // 不可精确表示的 f64:向上取下一个 f32
        let v = 1.0 + f64::EPSILON; // 略大于 1.0
        assert!(f64::from(next_float32(v)) >= v);
    }

    #[test]
    fn triangle_normal_rejects_collinear_and_repeated() {
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        assert!(triangle_normal(&positions, 0, 1, 2).is_none()); // 共线
        assert!(triangle_normal(&positions, 0, 0, 1).is_none()); // 重合顶点
        let n = triangle_normal(&positions, 0, 1, 3).expect("valid triangle");
        assert!((hypot3(n[0], n[1], n[2]) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn bounds_disable_cone_on_degenerate() {
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let bounds = compute_meshlet_bounds(&positions, &[0, 1, 2], &[], true).expect("bounds");
        assert_eq!(bounds.cone, [0.0, 0.0, 1.0, -1.0]);
    }

    #[test]
    fn hypot_matches_reference() {
        assert_eq!(hypot3(3.0, 4.0, 0.0), 5.0);
        assert_eq!(hypot2(3.0, 4.0), 5.0);
        assert_eq!(hypot3(0.0, 0.0, 0.0), 0.0);
        assert!(hypot3(f64::INFINITY, 1.0, 2.0).is_infinite());
    }
}
