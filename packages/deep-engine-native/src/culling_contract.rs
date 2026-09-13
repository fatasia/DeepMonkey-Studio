use crate::{
    cascaded_shadow::Matrix4,
    contract::{AlphaMode, GeometryResource, RenderPacket},
    scene::{PackedInstance, PreparedScene},
};

pub const GPU_CULLING_INSTANCE_BUDGET: usize = 1_048_576;
pub const GPU_CULLING_INSTANCE_BYTES: u64 = 144;
pub const GPU_CULLING_INDIRECT_BYTES: u64 = 20;
pub const GPU_CULLING_FRUSTUM_BYTES: u64 = 112;
pub const GPU_CULLING_WORKGROUP_SIZE: u32 = 64;
pub const MAIN_SOLID_MASK: u32 = 1;
pub const SHADOW_CASTER_MASK: u32 = 2;
pub type FrustumPlanes = [[f32; 4]; 6];

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedGpuCulling {
    pub bounds: Vec<[f32; 4]>,
    pub metadata: Vec<[u32; 4]>,
    pub indirect_template: Vec<[u32; 5]>,
}

pub fn prepare_gpu_culling(
    packet: &RenderPacket,
    scene: &PreparedScene,
) -> Result<PreparedGpuCulling, String> {
    if scene.instances.len() > GPU_CULLING_INSTANCE_BUDGET {
        return Err("native GPU culling input exceeds the 1048576 instance budget".into());
    }
    let spheres = packet
        .geometries
        .iter()
        .map(geometry_sphere)
        .collect::<Result<Vec<_>, _>>()?;
    let mut bounds = vec![[0.0; 4]; scene.instances.len()];
    let mut metadata = vec![[0; 4]; scene.instances.len()];
    let mut indirect_template = Vec::with_capacity(scene.batches.len());
    let mut covered = 0usize;
    for (batch_index, batch) in scene.batches.iter().enumerate() {
        let end = batch
            .instance_start
            .checked_add(batch.instance_count)
            .ok_or("native GPU culling batch range overflow")? as usize;
        if end > scene.instances.len() || batch.geometry_index >= spheres.len() {
            return Err("native GPU culling batch references invalid prepared data".into());
        }
        let mask = if batch.alpha_mode == AlphaMode::Blend || batch.lod {
            0
        } else {
            MAIN_SOLID_MASK | SHADOW_CASTER_MASK
        };
        for index in batch.instance_start as usize..end {
            bounds[index] = spheres[batch.geometry_index];
            metadata[index] = [batch_index as u32, mask, batch.instance_start, 0];
            covered += 1;
        }
        let index_count = u32::try_from(packet.geometries[batch.geometry_index].indices.len())
            .map_err(|_| "native GPU culling index count exceeds uint32")?;
        indirect_template.push([index_count, 0, 0, 0, 0]);
    }
    if covered != scene.instances.len() {
        return Err("native GPU culling batches do not cover every packed instance".into());
    }
    Ok(PreparedGpuCulling {
        bounds,
        metadata,
        indirect_template,
    })
}

pub fn frustum_planes(matrix: Matrix4) -> Result<FrustumPlanes, String> {
    let row = |index: usize| {
        [
            matrix[0][index],
            matrix[1][index],
            matrix[2][index],
            matrix[3][index],
        ]
    };
    let (x, y, z, w) = (row(0), row(1), row(2), row(3));
    let candidates = [add(w, x), sub(w, x), add(w, y), sub(w, y), z, sub(w, z)];
    let mut planes = [[0.0; 4]; 6];
    for (target, plane) in planes.iter_mut().zip(candidates) {
        let length = (plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]).sqrt();
        if !length.is_finite() || length < 1e-8 || plane.iter().any(|value| !value.is_finite()) {
            return Err("native GPU culling frustum contains a degenerate plane".into());
        }
        *target = plane.map(|value| value / length);
    }
    Ok(planes)
}

pub fn sphere_visible(planes: &FrustumPlanes, instance: &PackedInstance, bound: [f32; 4]) -> bool {
    let local = [bound[0], bound[1], bound[2], 1.0];
    let center = [
        dot4(&instance[0..4], local),
        dot4(&instance[4..8], local),
        dot4(&instance[8..12], local),
    ];
    let radius_squared = bound[3].max(0.0).powi(2);
    planes.iter().all(|plane| {
        let distance = dot3(&plane[..3], center) + plane[3];
        if distance >= 0.0 {
            return true;
        }
        // 把平面法线拉回局部空间，保留剪切和镜像下椭球的真实支撑半径。
        let normal: [f32; 3] = std::array::from_fn(|axis| {
            plane[0] * instance[axis]
                + plane[1] * instance[4 + axis]
                + plane[2] * instance[8 + axis]
        });
        distance * distance <= radius_squared * dot3(&normal, normal)
    })
}

pub(crate) fn geometry_sphere(geometry: &GeometryResource) -> Result<[f32; 4], String> {
    let (mut minimum, mut maximum) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    for &index in &geometry.indices {
        let offset = index as usize * 6;
        let position = geometry
            .vertices
            .get(offset..offset + 3)
            .ok_or("native GPU culling geometry index is out of range")?;
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(position[axis]);
            maximum[axis] = maximum[axis].max(position[axis]);
        }
    }
    let center = [
        (minimum[0] + maximum[0]) * 0.5,
        (minimum[1] + maximum[1]) * 0.5,
        (minimum[2] + maximum[2]) * 0.5,
    ];
    let radius = geometry
        .indices
        .iter()
        .map(|&index| {
            let offset = index as usize * 6;
            let position = &geometry.vertices[offset..offset + 3];
            ((position[0] - center[0]).powi(2)
                + (position[1] - center[1]).powi(2)
                + (position[2] - center[2]).powi(2))
            .sqrt()
        })
        .fold(0.0_f32, f32::max);
    if center
        .iter()
        .chain([&radius])
        .any(|value| !value.is_finite())
    {
        return Err("native GPU culling geometry bounds exceed float32".into());
    }
    Ok([center[0], center[1], center[2], radius])
}

fn add(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    std::array::from_fn(|index| a[index] + b[index])
}

fn sub(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    std::array::from_fn(|index| a[index] - b[index])
}

fn dot4(a: &[f32], b: [f32; 4]) -> f32 {
    a.iter().zip(b).map(|(left, right)| left * right).sum()
}

fn dot3(a: &[f32], b: [f32; 3]) -> f32 {
    a.iter().zip(b).map(|(left, right)| left * right).sum()
}
