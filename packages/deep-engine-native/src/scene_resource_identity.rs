use crate::{
    contract::{AlphaMode, RenderPacket, TextureSemantic},
    pbr_texture::{PreparedAddressMode, PreparedFilter, PreparedPbrResources, TextureEncoding},
    scene::PreparedScene,
};

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct ContentFingerprint(pub String);

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct VersionedResourceIdentity {
    pub id: String,
    pub revision: u64,
    pub content: ContentFingerprint,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct MaterialResourceIdentity {
    pub id: String,
    pub content: ContentFingerprint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SceneResourceManifest {
    pub geometries: Vec<VersionedResourceIdentity>,
    pub textures: Vec<VersionedResourceIdentity>,
    pub materials: Vec<MaterialResourceIdentity>,
    pub instances: ContentFingerprint,
}

pub fn scene_resource_manifest(
    packet: &RenderPacket,
    scene: &PreparedScene,
    pbr: &PreparedPbrResources,
) -> Result<SceneResourceManifest, String> {
    if packet.geometries.len() != scene.geometry_keys.len()
        || packet.textures.len() != pbr.textures.len()
        || packet.materials.len() != pbr.materials.len()
    {
        return Err("prepared native scene resources no longer match RenderPacket".into());
    }
    let geometries = packet
        .geometries
        .iter()
        .map(|geometry| {
            let mut hash = Fingerprint::new(b"geometry-v1");
            hash.f32s(&geometry.vertices);
            hash.optional_f32s(geometry.uv0.as_deref());
            hash.optional_f32s(geometry.uv1.as_deref());
            hash.optional_f32s(geometry.tangents.as_deref());
            hash.u32s(&geometry.indices);
            VersionedResourceIdentity {
                id: geometry.id.clone(),
                revision: geometry.revision,
                content: hash.finish(),
            }
        })
        .collect();
    let textures = pbr
        .textures
        .iter()
        .map(|texture| {
            let mut hash = Fingerprint::new(b"texture-v1");
            hash.u8(match texture.semantic {
                TextureSemantic::BaseColor => 0,
                TextureSemantic::MetallicRoughness => 1,
                TextureSemantic::Normal => 2,
                TextureSemantic::Occlusion => 3,
                TextureSemantic::Emissive => 4,
            });
            hash.u8(match texture.encoding {
                TextureEncoding::Linear => 0,
                TextureEncoding::Srgb => 1,
            });
            hash.sampler(texture.sampler);
            hash.usize(texture.levels.len());
            for level in &texture.levels {
                hash.u32(level.width);
                hash.u32(level.height);
                hash.bytes(&level.data);
            }
            VersionedResourceIdentity {
                id: texture.id.clone(),
                revision: texture.revision,
                content: hash.finish(),
            }
        })
        .collect::<Vec<_>>();
    let materials = pbr
        .materials
        .iter()
        .map(|material| {
            let mut hash = Fingerprint::new(b"material-v1");
            hash.bool(material.normal_mapped);
            hash.f32s(&material.uniform);
            for slot in material.texture_indices {
                match slot {
                    Some(index) => {
                        let dependency = textures.get(index).ok_or_else(|| {
                            format!("material {} texture index escaped preparation", material.id)
                        })?;
                        hash.bool(true);
                        hash.str(&dependency.id);
                        hash.u64(dependency.revision);
                        hash.fingerprint(&dependency.content);
                    }
                    None => hash.bool(false),
                }
            }
            Ok(MaterialResourceIdentity {
                id: material.id.clone(),
                content: hash.finish(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(SceneResourceManifest {
        geometries,
        textures,
        materials,
        instances: instance_fingerprint(scene),
    })
}

fn instance_fingerprint(scene: &PreparedScene) -> ContentFingerprint {
    let mut hash = Fingerprint::new(b"instances-v1");
    hash.usize(scene.instance_ids.len());
    for (id, instance) in scene.instance_ids.iter().zip(&scene.instances) {
        hash.str(id);
        hash.f32s(instance);
    }
    hash.usize(scene.batches.len());
    for batch in &scene.batches {
        hash.bool(batch.lod);
        hash.usize(batch.geometry_index);
        hash.usize(batch.material_index);
        hash.bool(batch.mirrored);
        hash.bool(batch.double_sided);
        hash.u8(match batch.alpha_mode {
            AlphaMode::Opaque => 0,
            AlphaMode::Mask => 1,
            AlphaMode::Blend => 2,
        });
        hash.usize(batch.stable_order);
        hash.u32(batch.instance_start);
        hash.u32(batch.instance_count);
        match batch.sort_center {
            Some(center) => {
                hash.bool(true);
                hash.f32s(&center);
            }
            None => hash.bool(false),
        }
    }
    hash.finish()
}

struct Fingerprint(crate::shader_package::hash::Sha256);

impl Fingerprint {
    fn new(domain: &[u8]) -> Self {
        let mut value = Self(crate::shader_package::hash::Sha256::new());
        value.bytes(domain);
        value
    }

    fn finish(self) -> ContentFingerprint {
        ContentFingerprint(self.0.finish())
    }

    fn bytes(&mut self, values: &[u8]) {
        self.raw(&(values.len() as u64).to_le_bytes());
        self.raw(values);
    }

    fn raw(&mut self, values: &[u8]) {
        self.0.update(values);
    }

    fn str(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }

    fn bool(&mut self, value: bool) {
        self.u8(u8::from(value));
    }

    fn u8(&mut self, value: u8) {
        self.raw(&[value]);
    }

    fn u32(&mut self, value: u32) {
        self.raw(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.raw(&value.to_le_bytes());
    }

    fn usize(&mut self, value: usize) {
        self.u64(value as u64);
    }

    fn f32s(&mut self, values: &[f32]) {
        self.usize(values.len());
        for value in values {
            self.u32(value.to_bits());
        }
    }

    fn u32s(&mut self, values: &[u32]) {
        self.usize(values.len());
        for &value in values {
            self.u32(value);
        }
    }

    fn optional_f32s(&mut self, values: Option<&[f32]>) {
        self.bool(values.is_some());
        if let Some(values) = values {
            self.f32s(values);
        }
    }

    fn fingerprint(&mut self, value: &ContentFingerprint) {
        self.str(&value.0);
    }

    fn sampler(&mut self, sampler: crate::pbr_texture::PreparedSampler) {
        self.u8(address(sampler.address_u));
        self.u8(address(sampler.address_v));
        self.u8(filter(sampler.mag));
        self.u8(filter(sampler.min));
        self.u8(filter(sampler.mipmap));
        self.u32(u32::from(sampler.anisotropy));
    }
}

fn address(value: PreparedAddressMode) -> u8 {
    match value {
        PreparedAddressMode::ClampToEdge => 0,
        PreparedAddressMode::Repeat => 1,
        PreparedAddressMode::MirrorRepeat => 2,
    }
}

fn filter(value: PreparedFilter) -> u8 {
    match value {
        PreparedFilter::Nearest => 0,
        PreparedFilter::Linear => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::Fingerprint;

    #[test]
    fn sha256_resource_domains_and_single_bits_are_distinct() {
        let digest = |domain: &[u8], payload: &[u8]| {
            let mut value = Fingerprint::new(domain);
            value.bytes(payload);
            value.finish().0
        };
        let geometry = digest(b"geometry-v1", b"same payload");
        let texture = digest(b"texture-v1", b"same payload");
        let changed = digest(b"geometry-v1", b"same payloae");
        assert_eq!(geometry.len(), 64);
        assert!(geometry.bytes().all(|value| value.is_ascii_hexdigit()));
        assert_ne!(geometry, texture, "resource domain must be hashed");
        assert_ne!(geometry, changed, "single-bit content update must differ");
    }
}
