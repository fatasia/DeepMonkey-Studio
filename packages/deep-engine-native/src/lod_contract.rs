use std::collections::HashMap;

use crate::{
    contract::{AlphaMode, RenderPacket},
    culling_contract::{GPU_CULLING_INSTANCE_BUDGET, geometry_sphere},
    scene::PreparedScene,
};

pub const GPU_LOD_VIEW_BYTES: u64 = 160;
pub const GPU_LOD_RECORD_BYTES: u64 = 48;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LodDraw {
    pub geometry_index: usize,
    pub instance_start: u32,
    pub indirect_index: u32,
    pub resident: bool,
}

#[derive(Clone, Debug)]
pub struct PreparedGpuLod {
    // Three vec4 records per object/level; floating fields use IEEE754 bits.
    pub objects: Vec<[[u32; 4]; 3]>,
    pub levels: Vec<[[u32; 4]; 3]>,
    pub batches: Vec<Vec<LodDraw>>,
    pub indirect_template: Vec<[u32; 5]>,
    pub visible_capacity: u32,
}

pub fn prepare_gpu_lod(
    packet: &RenderPacket,
    scene: &PreparedScene,
) -> Result<PreparedGpuLod, String> {
    let geometries: HashMap<_, _> = packet
        .geometries
        .iter()
        .enumerate()
        .map(|(index, geometry)| (geometry.id.as_str(), index))
        .collect();
    let instances: HashMap<_, _> = packet
        .instances
        .iter()
        .map(|instance| (instance.id.as_str(), instance))
        .collect();
    let mut result = PreparedGpuLod {
        objects: Vec::new(),
        levels: Vec::new(),
        batches: vec![Vec::new(); scene.batches.len()],
        indirect_template: Vec::new(),
        visible_capacity: 0,
    };
    for (batch_index, batch) in scene
        .batches
        .iter()
        .enumerate()
        .filter(|(_, batch)| batch.lod)
    {
        let id = scene
            .instance_ids
            .get(batch.instance_start as usize)
            .ok_or("native LOD batch source is missing")?;
        let profile = instances
            .get(id.as_str())
            .and_then(|instance| instance.lod.as_ref())
            .ok_or("native LOD profile is missing from its source batch")?;
        let indices: Vec<_> = profile
            .levels
            .iter()
            .map(|level| {
                geometries
                    .get(level.geometry.as_str())
                    .copied()
                    .ok_or("native LOD geometry is missing")
            })
            .collect::<Result<_, _>>()?;
        let bounds: Vec<_> = indices
            .iter()
            .map(|&index| geometry_sphere(&packet.geometries[index]))
            .collect::<Result<_, _>>()?;
        let union = union_sphere(&bounds)?;
        let level_start = result.levels.len() as u32;
        for ((level, &geometry_index), bound) in profile.levels.iter().zip(&indices).zip(bounds) {
            let draw_index = result.indirect_template.len() as u32;
            let start = result.visible_capacity;
            result.visible_capacity = start
                .checked_add(batch.instance_count)
                .ok_or("native LOD visible capacity overflow")?;
            // Bound amplified output memory before allocating any GPU resources.
            if result.visible_capacity as usize > GPU_CULLING_INSTANCE_BUDGET {
                return Err(
                    "native LOD expanded visible slots exceed the 1048576 instance budget".into(),
                );
            }
            let index_count = u32::try_from(packet.geometries[geometry_index].indices.len())
                .map_err(|_| "native LOD index count exceeds uint32")?;
            result.indirect_template.push([index_count, 0, 0, 0, 0]);
            result.batches[batch_index].push(LodDraw {
                geometry_index,
                instance_start: start,
                indirect_index: draw_index,
                resident: level.is_resident(),
            });
            result.levels.push([
                [draw_index, start, u32::from(level.is_resident()), 0],
                bound.map(f32::to_bits),
                [
                    (level.min_projected_diameter_pixels as f32).to_bits(),
                    (level.geometric_error as f32).to_bits(),
                    0,
                    0,
                ],
            ]);
        }
        let flags = if batch.alpha_mode == AlphaMode::Blend {
            1
        } else {
            3
        };
        for source in batch.instance_start..batch.instance_start + batch.instance_count {
            result.objects.push([
                [source, level_start, profile.levels.len() as u32, flags],
                union.map(f32::to_bits),
                [(profile.hysteresis_ratio() as f32).to_bits(), 0, 0, 0],
            ]);
        }
    }
    Ok(result)
}

fn union_sphere(bounds: &[[f32; 4]]) -> Result<[f32; 4], String> {
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    for bound in bounds {
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(f64::from(bound[axis]) - f64::from(bound[3]));
            maximum[axis] = maximum[axis].max(f64::from(bound[axis]) + f64::from(bound[3]));
        }
    }
    let center: [f32; 3] =
        std::array::from_fn(|axis| ((minimum[axis] + maximum[axis]) * 0.5) as f32);
    let radius = bounds
        .iter()
        .map(|bound| {
            (0..3)
                .map(|axis| (f64::from(bound[axis]) - f64::from(center[axis])).powi(2))
                .sum::<f64>()
                .sqrt()
                + f64::from(bound[3])
        })
        .fold(0.0, f64::max);
    let mut rounded = radius as f32;
    if f64::from(rounded) < radius {
        rounded = rounded.next_up();
    }
    if center.iter().any(|value| !value.is_finite()) || !rounded.is_finite() {
        return Err("native LOD profile bounds exceed float32".into());
    }
    Ok([center[0], center[1], center[2], rounded])
}
