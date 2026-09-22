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

/// Resolve an orbit camera center against the same transformed triangles and
/// section plane used by picking. The query is allocation-free for ordinary
/// outside motion and does no work for an empty packet.
pub fn resolve_camera_collision(
    packet: &RenderPacket,
    previous: Option<PlayerView>,
    desired: PlayerView,
    radius: f32,
    distance_range: [f32; 2],
) -> PlayerView {
    if packet.instances.is_empty() || packet.geometries.is_empty() {
        return desired;
    }
    let desired_eye = desired.eye();
    if point_inside(packet, desired, desired_eye) {
        if let Some(surface) = nearest_surface(packet, desired, desired_eye) {
            let outward = normalise(sub(surface, desired_eye));
            if let Some(outward) = outward {
                let recovered = add(surface, scale(outward, radius));
                return view_at_eye(desired, recovered, distance_range);
            }
        }
        return previous.unwrap_or(desired);
    }

    let start = previous.map(PlayerView::eye).unwrap_or(desired.target);
    if point_inside(packet, desired, start) {
        return desired;
    }
    let motion = sub(desired_eye, start);
    let length = dot(motion, motion).sqrt();
    if !length.is_finite() || length <= f32::EPSILON {
        return desired;
    }
    let direction = scale(motion, 1.0 / length);
    let mut nearest = length;
    visit_triangles(packet, |_, _, triangle| {
        if let Some(distance) = intersect(start, direction, triangle[0], triangle[1], triangle[2])
            && distance >= 0.0
            && distance < nearest
        {
            let point = add(start, scale(direction, distance));
            if section_visible(desired, point) {
                nearest = distance;
            }
        }
    });
    if nearest >= length {
        return desired;
    }
    let corrected = add(start, scale(direction, (nearest - radius).max(0.0)));
    view_at_eye(desired, corrected, distance_range)
}

fn view_at_eye(desired: PlayerView, eye: [f32; 3], distance_range: [f32; 2]) -> PlayerView {
    let offset = sub(eye, desired.target);
    let Some(direction) = normalise(offset) else {
        return desired;
    };
    let distance = dot(offset, offset)
        .sqrt()
        .clamp(distance_range[0], distance_range[1]);
    let target = sub(eye, scale(direction, distance));
    desired.with_eye_target(eye, target).unwrap_or(desired)
}

fn point_inside(packet: &RenderPacket, view: PlayerView, point: [f32; 3]) -> bool {
    let direction = normalise([0.917, 0.307, 0.259]).unwrap();
    packet.instances.iter().any(|instance| {
        let mut crossings = 0_u32;
        visit_instance_triangles(packet, instance, |triangle| {
            if let Some(distance) =
                intersect(point, direction, triangle[0], triangle[1], triangle[2])
                && distance > 1e-5
            {
                let hit = add(point, scale(direction, distance));
                if section_visible(view, hit) {
                    crossings += 1;
                }
            }
        });
        crossings % 2 == 1
    })
}

fn nearest_surface(packet: &RenderPacket, view: PlayerView, point: [f32; 3]) -> Option<[f32; 3]> {
    let mut nearest = None;
    let mut nearest_squared = f32::INFINITY;
    visit_triangles(packet, |_, _, triangle| {
        let candidate = closest_triangle_point(point, triangle[0], triangle[1], triangle[2]);
        let squared = dot(sub(candidate, point), sub(candidate, point));
        if squared < nearest_squared && section_visible(view, candidate) {
            nearest_squared = squared;
            nearest = Some(candidate);
        }
    });
    nearest
}

fn section_visible(view: PlayerView, point: [f32; 3]) -> bool {
    (0..3)
        .map(|axis| view.clipping[axis] * point[axis])
        .sum::<f32>()
        + view.clipping[3]
        >= 0.0
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
        for geometry in packet
            .geometries
            .iter()
            .filter(|geometry| geometry_selected(instance, geometry))
        {
            let mut hit = None;
            for triangle in geometry.indices.chunks_exact(3) {
                let (Some(a), Some(b), Some(c)) = (
                    transformed_vertex(geometry, instance, triangle[0]),
                    transformed_vertex(geometry, instance, triangle[1]),
                    transformed_vertex(geometry, instance, triangle[2]),
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
                for point in geometry
                    .indices
                    .iter()
                    .filter_map(|index| transformed_vertex(geometry, instance, *index))
                {
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

fn visit_triangles(
    packet: &RenderPacket,
    mut visit: impl FnMut(&deep_engine_native::contract::RenderInstance, f32, [[f32; 3]; 3]),
) {
    for instance in &packet.instances {
        let m = &instance.transform;
        let determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9])
            + m[8] * (m[1] * m[6] - m[2] * m[5]);
        if !determinant.is_finite() || determinant.abs() < 1e-12 {
            continue;
        }
        visit_instance_triangles(packet, instance, |triangle| {
            visit(instance, determinant, triangle)
        });
    }
}

fn visit_instance_triangles(
    packet: &RenderPacket,
    instance: &deep_engine_native::contract::RenderInstance,
    mut visit: impl FnMut([[f32; 3]; 3]),
) {
    for geometry in packet
        .geometries
        .iter()
        .filter(|geometry| geometry_selected(instance, geometry))
    {
        for indices in geometry.indices.chunks_exact(3) {
            let (Some(a), Some(b), Some(c)) = (
                transformed_vertex(geometry, instance, indices[0]),
                transformed_vertex(geometry, instance, indices[1]),
                transformed_vertex(geometry, instance, indices[2]),
            ) else {
                continue;
            };
            visit([a, b, c]);
        }
    }
}

fn geometry_selected(
    instance: &deep_engine_native::contract::RenderInstance,
    geometry: &deep_engine_native::contract::GeometryResource,
) -> bool {
    instance
        .lod
        .as_ref()
        .and_then(|lod| lod.author.as_ref())
        .map_or(geometry.id == instance.geometry, |author| {
            author.selected_levels.iter().any(|&index| {
                author
                    .levels
                    .get(index)
                    .is_some_and(|level| level.geometry == geometry.id)
            })
        })
}

fn transformed_vertex(
    geometry: &deep_engine_native::contract::GeometryResource,
    instance: &deep_engine_native::contract::RenderInstance,
    index: u32,
) -> Option<[f32; 3]> {
    let offset = (index as usize).checked_mul(6)?;
    let local = geometry.vertices.get(offset..offset.checked_add(3)?)?;
    let world = std::array::from_fn(|axis| {
        instance.transform[12 + axis]
            + (0..3)
                .map(|column| instance.transform[column * 4 + axis] * local[column])
                .sum::<f32>()
    });
    world.iter().all(|value| value.is_finite()).then_some(world)
}

fn closest_triangle_point(point: [f32; 3], a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> [f32; 3] {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(point, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = sub(point, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return add(a, scale(ab, d1 / (d1 - d3)));
    }
    let cp = sub(point, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return add(a, scale(ac, d2 / (d2 - d6)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    }
    let denominator = 1.0 / (va + vb + vc);
    add(
        a,
        add(scale(ab, vb * denominator), scale(ac, vc * denominator)),
    )
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
fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    std::array::from_fn(|i| a[i] + b[i])
}
fn scale(value: [f32; 3], factor: f32) -> [f32; 3] {
    value.map(|component| component * factor)
}
fn normalise(value: [f32; 3]) -> Option<[f32; 3]> {
    let length = dot(value, value).sqrt();
    (length.is_finite() && length > f32::EPSILON).then(|| scale(value, 1.0 / length))
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
