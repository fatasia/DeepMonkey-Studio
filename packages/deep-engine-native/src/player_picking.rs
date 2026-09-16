//! CPU triangle picking uses the same orbit camera and authored instance identities as rendering.
use crate::player_state::PlayerView;
use deep_engine_native::contract::RenderPacket;

#[derive(Debug, PartialEq)]
pub struct Pick {
    pub id: String,
    pub point: [f32; 3],
    pub center: [f32; 3],
    pub radius: f32,
}

/// 保留渲染局部命中；只有经内容坐标帧验证的 f64 世界点才可交给工具。
pub struct WorldPick {
    pub local: Pick,
    pub world_point: [f64; 3],
}

pub fn pick_world(
    content: &crate::player_content::PlayerContent,
    view: PlayerView,
    size: [u32; 2],
    pixel: [f64; 2],
) -> Option<WorldPick> {
    let local = pick(content.packet(), view, size, pixel)?;
    let world_point = content.local_to_world(local.point.map(f64::from)).ok()?;
    Some(WorldPick { local, world_point })
}

pub fn pick(
    packet: &RenderPacket,
    view: PlayerView,
    size: [u32; 2],
    pixel: [f64; 2],
) -> Option<Pick> {
    if size.contains(&0)
        || pixel.iter().any(|v| !v.is_finite())
        || pixel[0] < 0.0
        || pixel[1] < 0.0
        || pixel[0] >= size[0] as f64
        || pixel[1] >= size[1] as f64
    {
        return None;
    }
    let aspect = size[0] as f32 / size[1] as f32;
    let x = (2.0 * pixel[0] as f32 / size[0] as f32 - 1.0) * aspect / view.focal;
    let y = (1.0 - 2.0 * pixel[1] as f32 / size[1] as f32) / view.focal;
    let [right, up, forward] = view.basis();
    let origin = view.eye();
    // Unnormalised direction keeps t in camera depth units, matching near/far clipping.
    let direction = std::array::from_fn(|i| right[i] * x + up[i] * y + forward[i]);
    let mut nearest = view.far;
    let mut selected = None;
    for instance in &packet.instances {
        let double_sided = packet
            .materials
            .iter()
            .find(|m| m.id == instance.material)
            .and_then(|m| m.double_sided)
            .unwrap_or(false);
        let m = &instance.transform;
        let determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9])
            + m[8] * (m[1] * m[6] - m[2] * m[5]);
        if !determinant.is_finite() || determinant.abs() < 1e-12 {
            continue;
        }
        let author = instance.lod.as_ref().and_then(|lod| lod.author.as_ref());
        for geometry in packet.geometries.iter().filter(|g| {
            author.map_or(g.id == instance.geometry, |a| {
                a.selected_levels.iter().any(|&index| {
                    a.levels
                        .get(index)
                        .is_some_and(|level| level.geometry == g.id)
                })
            })
        }) {
            let vertex = |index: u32| -> Option<[f32; 3]> {
                let offset = (index as usize).checked_mul(6)?;
                let local = geometry.vertices.get(offset..offset.checked_add(3)?)?;
                let world = std::array::from_fn(|axis| {
                    instance.transform[12 + axis]
                        + (0..3)
                            .map(|column| instance.transform[column * 4 + axis] * local[column])
                            .sum::<f32>()
                });
                if world.iter().all(|v| v.is_finite()) {
                    Some(world)
                } else {
                    None
                }
            };
            let mut hit = None;
            for triangle in geometry.indices.chunks_exact(3) {
                let (Some(a), Some(b), Some(c)) = (
                    vertex(triangle[0]),
                    vertex(triangle[1]),
                    vertex(triangle[2]),
                ) else {
                    continue;
                };
                if let Some(distance) = intersect(origin, direction, a, b, c)
                    && distance >= view.near
                    && distance < nearest
                {
                    if !double_sided
                        && dot(cross(sub(b, a), sub(c, a)), direction) * determinant.signum() >= 0.0
                    {
                        continue;
                    }
                    let point =
                        std::array::from_fn(|axis| origin[axis] + direction[axis] * distance);
                    if (0..3)
                        .map(|axis| view.clipping[axis] * point[axis])
                        .sum::<f32>()
                        + view.clipping[3]
                        < 0.0
                    {
                        continue;
                    }
                    nearest = distance;
                    hit = Some(point);
                }
            }
            if let Some(point) = hit {
                let mut low = [f32::INFINITY; 3];
                let mut high = [f32::NEG_INFINITY; 3];
                for point in geometry.indices.iter().filter_map(|index| vertex(*index)) {
                    for axis in 0..3 {
                        low[axis] = low[axis].min(point[axis]);
                        high[axis] = high[axis].max(point[axis]);
                    }
                }
                let center = std::array::from_fn(|axis| (low[axis] + high[axis]) * 0.5);
                let radius = dot(sub(high, center), sub(high, center)).sqrt();
                selected = Some(Pick {
                    id: instance.id.clone(),
                    point,
                    center,
                    radius,
                });
            }
        }
    }
    selected
}

pub fn focus(view: &mut PlayerView, hit: &Pick, size: [u32; 2]) {
    let aspect = size[0].max(1) as f32 / size[1].max(1) as f32;
    let half_fov = (aspect.min(1.0) / view.focal).atan();
    view.target = hit.center;
    let maximum = view.far * 0.8;
    view.distance = (hit.radius / half_fov.sin() * 1.15).clamp(0.5_f32.min(maximum), maximum);
}

fn intersect(
    origin: [f32; 3],
    direction: [f32; 3],
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
) -> Option<f32> {
    let edge = sub(b, a);
    let other = sub(c, a);
    let p = cross(direction, other);
    let determinant = dot(edge, p);
    if determinant.abs() < 1e-8 {
        return None;
    }
    let delta = sub(origin, a);
    let u = dot(delta, p) / determinant;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(delta, edge);
    let v = dot(direction, q) / determinant;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let distance = dot(other, q) / determinant;
    distance.is_finite().then_some(distance)
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    (0..3).map(|i| a[i] * b[i]).sum()
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[cfg(test)]
#[path = "player_picking_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "player_picking_world_tests.rs"]
mod world_tests;
