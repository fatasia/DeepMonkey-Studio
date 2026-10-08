//! Per-cascade shadow invalidation from snapped views and relevant caster bounds.

use std::{collections::HashMap, fmt::Write, hash::Hasher};

use deep_engine_native::{
    contract::{AlphaMode, RenderPacket},
    culling_contract::PreparedGpuCulling,
    lod_contract::PreparedGpuLod,
    scene::{PackedInstance, PreparedScene},
};
use serde::Serialize;

use crate::shadow_map::ShadowViewSource;

const MAX_CASCADES: usize = 14;

pub fn shader_key(signature: Option<&str>) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    hash.write(b"native-shadow-shader-v1");
    if let Some(signature) = signature {
        hash.write_u8(1);
        hash.write(signature.as_bytes());
    } else {
        hash.write_u8(0);
    }
    hash.finish()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ShadowCascadeKey {
    view: u64,
    casters: u64,
    shader: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ShadowDirtyEvidence {
    pub dirty_mask: u16,
    pub updated: [bool; MAX_CASCADES],
    pub reused: [bool; MAX_CASCADES],
    pub cascade_count: u8,
}

#[derive(Default)]
pub struct ShadowDirtyCache {
    rendered: [Option<ShadowCascadeKey>; MAX_CASCADES],
}

impl ShadowDirtyCache {
    pub fn plan(&self, current: &[ShadowCascadeKey]) -> ShadowDirtyEvidence {
        debug_assert!((2..=MAX_CASCADES).contains(&current.len()));
        let mut evidence = ShadowDirtyEvidence {
            cascade_count: current.len() as u8,
            ..Default::default()
        };
        for (index, key) in current.iter().enumerate() {
            let dirty = self.rendered[index] != Some(*key);
            evidence.updated[index] = dirty;
            evidence.reused[index] = !dirty;
            if dirty {
                evidence.dirty_mask |= 1 << index;
            }
        }
        evidence
    }

    pub fn commit(&mut self, current: &[ShadowCascadeKey], evidence: ShadowDirtyEvidence) {
        for (index, key) in current.iter().enumerate() {
            if evidence.updated[index] {
                self.rendered[index] = Some(*key);
            }
        }
    }

    pub fn invalidate(&mut self) {
        self.rendered = [None; MAX_CASCADES];
    }
    pub fn invalidate_directional(&mut self, cascade_count: usize) {
        self.rendered[..cascade_count.min(MAX_CASCADES)].fill(None);
    }
}

#[derive(Clone, Debug)]
struct ShadowCaster {
    instance: PackedInstance,
    bound: [f32; 4],
    fingerprint: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ShadowCasterSet {
    casters: Vec<ShadowCaster>,
    view_keys: std::cell::RefCell<Vec<Option<caster_keys::CachedView>>>,
}

impl ShadowCasterSet {
    pub fn prepare(
        packet: &RenderPacket,
        scene: &PreparedScene,
        culling: &PreparedGpuCulling,
        lod: &PreparedGpuLod,
    ) -> Result<Self, String> {
        if scene.instances.len() != culling.bounds.len()
            || scene.instances.len() != scene.instance_ids.len()
        {
            return Err("shadow dirty inputs no longer align with prepared instances".into());
        }
        let lod_bounds = lod
            .objects
            .iter()
            .map(|object| {
                let source = object[0][0] as usize;
                (source, object[1].map(f32::from_bits))
            })
            .collect::<HashMap<_, _>>();
        let instances = packet
            .instances
            .iter()
            .map(|instance| (instance.id.as_str(), instance))
            .collect::<HashMap<_, _>>();
        let materials = packet
            .materials
            .iter()
            .map(|material| (material.id.as_str(), material))
            .collect::<HashMap<_, _>>();
        let geometries = packet
            .geometries
            .iter()
            .map(|geometry| (geometry.id.as_str(), geometry))
            .collect::<HashMap<_, _>>();
        let textures = packet
            .textures
            .iter()
            .map(|texture| (texture.id.as_str(), texture))
            .collect::<HashMap<_, _>>();
        let mut casters = Vec::new();
        // Resource contents are identical for every instance in this prepare.
        // Keep these caches local: a later packet may change bytes without a revision bump.
        let mut geometry_digests = HashMap::new();
        let mut texture_digests = HashMap::new();
        for batch in &scene.batches {
            if !batch.cast_shadow || batch.alpha_mode == AlphaMode::Blend {
                continue;
            }
            let end = (batch.instance_start + batch.instance_count) as usize;
            for source in batch.instance_start as usize..end {
                let id = scene
                    .instance_ids
                    .get(source)
                    .ok_or("shadow caster source id is missing")?;
                let authored = instances
                    .get(id.as_str())
                    .ok_or("shadow caster authored instance is missing")?;
                let material = materials
                    .get(authored.material.as_str())
                    .ok_or("shadow caster material is missing")?;
                let bound = lod_bounds
                    .get(&source)
                    .copied()
                    .unwrap_or(culling.bounds[source]);
                let mut hash = HashWriter::new(b"native-shadow-caster-v2");
                write!(
                    &mut hash,
                    "{}{:?}{}{:?}{:?}",
                    authored.id,
                    authored.transform,
                    authored.material,
                    authored.lod,
                    (material.alpha_mode, material.double_sided)
                )
                .unwrap();
                let masked = material.alpha_mode == Some(AlphaMode::Mask);
                hash.geometry(
                    authored.geometry.as_str(),
                    &geometries,
                    masked,
                    &mut geometry_digests,
                )?;
                if let Some(profile) = &authored.lod {
                    for level in &profile.levels {
                        hash.geometry(
                            level.geometry.as_str(),
                            &geometries,
                            masked,
                            &mut geometry_digests,
                        )?;
                    }
                }
                if masked {
                    write!(
                        &mut hash,
                        "{:?}{:?}{:?}",
                        material.alpha_cutoff,
                        material.base_color_alpha,
                        material.base_color_texture
                    )
                    .unwrap();
                    if let Some(slot) = &material.base_color_texture {
                        hash.texture(slot.texture.as_str(), &textures, &mut texture_digests)?;
                    }
                }
                casters.push(ShadowCaster {
                    instance: scene.instances[source],
                    bound,
                    fingerprint: hash.finish(),
                });
            }
        }
        Ok(Self {
            casters,
            view_keys: Default::default(),
        })
    }
}

#[path = "shadow_hash_writer.rs"]
mod hash_writer;
use hash_writer::HashWriter;

#[cfg(test)]
#[path = "shadow_dirty_tests.rs"]
mod tests;

#[path = "shadow_caster_keys.rs"]
mod caster_keys;
