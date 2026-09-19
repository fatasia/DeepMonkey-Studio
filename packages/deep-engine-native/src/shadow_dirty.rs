//! Per-cascade shadow invalidation from snapped views and relevant caster bounds.

use std::{collections::HashMap, fmt::Write, hash::Hasher};

use deep_engine_native::{
    contract::{AlphaMode, RenderPacket},
    culling_contract::{PreparedGpuCulling, frustum_planes, sphere_visible},
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
                let mut hash = HashWriter::new(b"native-shadow-caster-v1");
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
                hash.geometry(authored.geometry.as_str(), &geometries, masked)?;
                if let Some(profile) = &authored.lod {
                    for level in &profile.levels {
                        hash.geometry(level.geometry.as_str(), &geometries, masked)?;
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
                        hash.texture(slot.texture.as_str(), &textures)?;
                    }
                }
                casters.push(ShadowCaster {
                    instance: scene.instances[source],
                    bound,
                    fingerprint: hash.finish(),
                });
            }
        }
        Ok(Self { casters })
    }

    pub fn keys(
        &self,
        views: &impl ShadowViewSource,
        shader_revision: u64,
    ) -> Result<Vec<ShadowCascadeKey>, String> {
        (0..views.shadow_view_count() as usize)
            .map(|cascade| {
                let matrix = views.shadow_view_projection(cascade);
                let planes = frustum_planes(matrix)?;
                let mut view = std::collections::hash_map::DefaultHasher::new();
                for value in matrix.into_iter().flatten() {
                    view.write_u32(value.to_bits());
                }
                let mut casters = std::collections::hash_map::DefaultHasher::new();
                let mut count = 0_u64;
                for caster in &self.casters {
                    if sphere_visible(&planes, &caster.instance, caster.bound) {
                        casters.write_u64(caster.fingerprint);
                        count += 1;
                    }
                }
                casters.write_u64(count);
                Ok(ShadowCascadeKey {
                    view: view.finish(),
                    casters: casters.finish(),
                    shader: shader_revision,
                })
            })
            .collect()
    }
}

struct HashWriter(std::collections::hash_map::DefaultHasher);

impl HashWriter {
    fn new(domain: &[u8]) -> Self {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        hash.write(domain);
        Self(hash)
    }

    fn geometry(
        &mut self,
        id: &str,
        resources: &HashMap<&str, &deep_engine_native::contract::GeometryResource>,
        include_uv0: bool,
    ) -> Result<(), String> {
        let geometry = resources
            .get(id)
            .ok_or_else(|| format!("shadow caster geometry {id} is missing"))?;
        write!(
            self,
            "{}{:?}{:?}",
            geometry.id, geometry.vertices, geometry.indices
        )
        .unwrap();
        if include_uv0 {
            write!(self, "{:?}", geometry.uv0).unwrap();
        }
        Ok(())
    }

    fn texture(
        &mut self,
        id: &str,
        resources: &HashMap<&str, &deep_engine_native::contract::TextureResource>,
    ) -> Result<(), String> {
        let texture = resources
            .get(id)
            .ok_or_else(|| format!("shadow caster texture {id} is missing"))?;
        write!(
            self,
            "{}{:?}{:?}{:?}{:?}{:?}{:?}{:?}",
            texture.id,
            texture.semantic,
            texture.width,
            texture.height,
            texture.data,
            texture.bytes_per_row,
            texture.mipmaps,
            texture.sampler
        )
        .unwrap();
        Ok(())
    }

    fn finish(self) -> u64 {
        self.0.finish()
    }
}

impl Write for HashWriter {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        self.0.write(text.as_bytes());
        Ok(())
    }
}

#[cfg(test)]
#[path = "shadow_dirty_tests.rs"]
mod tests;
