use std::collections::HashMap;

use crate::contract::{AlphaMode, RenderPacket, validate_packet};
use crate::scene_pack::*;

pub use crate::mesh_abi::{PACKED_INSTANCE_BYTES, PACKED_INSTANCE_FLOATS};
pub use crate::scene_alpha::{alpha_summary, transparent_batch_order};

pub type PackedInstance = [f32; PACKED_INSTANCE_FLOATS];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeometryKey {
    pub id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DrawBatch {
    pub lod: bool,
    pub geometry_index: usize,
    pub material_index: usize,
    pub mirrored: bool,
    pub double_sided: bool,
    pub alpha_mode: AlphaMode,
    pub sort_center: Option<[f32; 3]>,
    pub stable_order: usize,
    pub instance_start: u32,
    pub instance_count: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SceneAlphaSummary {
    pub opaque_batches: usize,
    pub mask_batches: usize,
    pub blend_batches: usize,
    pub double_sided_batches: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedScene {
    pub geometry_keys: Vec<GeometryKey>,
    pub material_ids: Vec<String>,
    pub instance_ids: Vec<String>,
    pub instances: Vec<PackedInstance>,
    pub batches: Vec<DrawBatch>,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct BatchKey {
    lod_profile: Option<usize>,
    geometry_index: usize,
    material_index: usize,
    mirrored: bool,
    double_sided: bool,
    alpha_mode: AlphaMode,
    blend_instance: Option<usize>,
}

struct PendingBatch {
    key: BatchKey,
    sort_center: Option<[f32; 3]>,
    instances: Vec<(String, PackedInstance)>,
}

pub fn prepare_scene(packet: &RenderPacket) -> Result<PreparedScene, String> {
    validate_packet(packet)?;
    let mut geometry_map = HashMap::with_capacity(packet.geometries.len());
    let mut geometry_keys = Vec::with_capacity(packet.geometries.len());
    let mut geometry_centers = Vec::with_capacity(packet.geometries.len());
    for (index, geometry) in packet.geometries.iter().enumerate() {
        if geometry_map.insert(geometry.id.as_str(), index).is_some() {
            return Err(format!("duplicate geometry id {}", geometry.id));
        }
        geometry_keys.push(GeometryKey {
            id: geometry.id.clone(),
            revision: geometry.revision,
        });
        geometry_centers.push(geometry_center(&geometry.vertices, &geometry.indices));
    }

    let mut material_map = HashMap::with_capacity(packet.materials.len());
    let mut material_ids = Vec::with_capacity(packet.materials.len());
    for (index, material) in packet.materials.iter().enumerate() {
        if material_map.insert(material.id.as_str(), index).is_some() {
            return Err(format!("duplicate material id {}", material.id));
        }
        material_ids.push(material.id.clone());
    }

    let mut batch_map = HashMap::new();
    let mut profiles = HashMap::new();
    let mut pending: Vec<PendingBatch> = Vec::new();
    for (instance_order, instance) in packet.instances.iter().enumerate() {
        let geometry_index = geometry_map
            .get(instance.geometry.as_str())
            .copied()
            .ok_or_else(|| format!("instance {} geometry is missing", instance.id))?;
        let material_index = material_map
            .get(instance.material.as_str())
            .copied()
            .ok_or_else(|| format!("instance {} material is missing", instance.id))?;
        let determinant = determinant3(&instance.transform);
        let scale = column_norm(&instance.transform, 0)
            * column_norm(&instance.transform, 4)
            * column_norm(&instance.transform, 8);
        if !determinant.is_finite() || scale == 0.0 || determinant.abs() < scale * 1e-8 {
            return Err(format!("instance {} transform is singular", instance.id));
        }
        let material = &packet.materials[material_index];
        let double_sided = material.double_sided.unwrap_or(false);
        let alpha_mode = material.alpha_mode.unwrap_or(AlphaMode::Opaque);
        let mirrored = determinant.is_sign_negative();
        let sort_center = (alpha_mode == AlphaMode::Blend)
            .then(|| transform_center(&instance.transform, geometry_centers[geometry_index]))
            .transpose()?;
        let lod_profile = instance.lod.as_ref().map(|profile| {
            let key = (
                profile.hysteresis_ratio().to_bits(),
                profile
                    .levels
                    .iter()
                    .map(|level| {
                        (
                            level.geometry.clone(),
                            level.min_projected_diameter_pixels.to_bits(),
                            level.geometric_error.to_bits(),
                            level.is_resident(),
                        )
                    })
                    .collect::<Vec<_>>(),
            );
            let next = profiles.len();
            *profiles.entry(key).or_insert(next)
        });
        let key = BatchKey {
            lod_profile,
            geometry_index,
            material_index,
            mirrored: !double_sided && mirrored,
            double_sided,
            alpha_mode,
            blend_instance: (alpha_mode == AlphaMode::Blend).then_some(instance_order),
        };
        let batch_index = match batch_map.get(&key) {
            Some(&index) => index,
            None => {
                let index = pending.len();
                batch_map.insert(key, index);
                pending.push(PendingBatch {
                    key,
                    sort_center,
                    instances: Vec::new(),
                });
                index
            }
        };
        pending[batch_index].instances.push((
            instance.id.clone(),
            pack_instance(
                &instance.transform,
                inverse_transpose3(&instance.transform, determinant),
                material,
                if mirrored { -1.0 } else { 1.0 },
                alpha_flags(alpha_mode, double_sided),
            ),
        ));
    }

    let mut instance_ids = Vec::with_capacity(packet.instances.len());
    let mut instances = Vec::with_capacity(packet.instances.len());
    let mut batches = Vec::with_capacity(pending.len());
    for (stable_order, batch) in pending.into_iter().enumerate() {
        let instance_start = instances.len() as u32;
        let instance_count = batch.instances.len() as u32;
        for (id, instance) in batch.instances {
            instance_ids.push(id);
            instances.push(instance);
        }
        batches.push(DrawBatch {
            lod: batch.key.lod_profile.is_some(),
            geometry_index: batch.key.geometry_index,
            material_index: batch.key.material_index,
            mirrored: batch.key.mirrored,
            double_sided: batch.key.double_sided,
            alpha_mode: batch.key.alpha_mode,
            sort_center: batch.sort_center,
            stable_order,
            instance_start,
            instance_count,
        });
    }

    Ok(PreparedScene {
        geometry_keys,
        material_ids,
        instance_ids,
        instances,
        batches,
    })
}
