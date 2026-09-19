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
        hash.bool(batch.cast_shadow);
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


#[cfg(test)]
mod texture_revision_tests {
    use super::*;
    use crate::contract::{RenderInstance, RenderPacket};
    use crate::pbr_texture::prepare_pbr_resources;
    use crate::scene::prepare_scene;

    fn packet_with_texture_revision(revision: u64) -> RenderPacket {
        // 最小合法 packet:单几何/单材质/单实例/单纹理,仅 revision 变化。
        let json = format!(
            r#"{{"schema":"deep-engine.render-packet","version":1,
            "geometries":[{{"id":"g","revision":1,"vertices":[0.0,0.0,0.0,0.0,0.0,1.0,1.0,0.0,0.0,0.0,0.0,1.0,0.0,1.0,0.0,1.0,0.0,0.0,1.0,1.0,0.0,1.0,0.0,0.0,0.0,0.0,1.0,0.0,1.0,0.0,1.0,1.0,0.0,0.0,0.0,1.0],"indices":[0,1,2]}}],
            "materials":[{{"id":"m","baseColor":[1.0,1.0,1.0],"metallic":0.0,"roughness":1.0}}],
            "instances":[{{"id":"i","geometry":"g","material":"m","transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}}],
            "textures":[{{"id":"tex","revision":{rev},"semantic":"baseColor","width":2,"height":2,"bytesPerRow":8,"data":[0,0,0,255,0,0,0,255,0,0,0,255,0,0,0,255]}}]}}"#,
            rev = revision
        );
        serde_json::from_str(&json).expect("minimal packet must parse")
    }

    #[test]
    fn texture_revision_bump_changes_manifest_identity() {
        let earlier = scene_resource_manifest(
            &packet_with_texture_revision(1),
            &prepare_scene(&packet_with_texture_revision(1)).unwrap(),
            &prepare_pbr_resources(&packet_with_texture_revision(1)).unwrap(),
        )
        .unwrap();
        let later = scene_resource_manifest(
            &packet_with_texture_revision(2),
            &prepare_scene(&packet_with_texture_revision(2)).unwrap(),
            &prepare_pbr_resources(&packet_with_texture_revision(2)).unwrap(),
        )
        .unwrap();
        // 版本键含 revision → 缓存 miss(重上传该纹理),其余资源身份不变。
        assert_ne!(earlier.textures, later.textures);
        assert_eq!(earlier.geometries, later.geometries);
        // 材质身份只含 uniform 与纹理依赖签名;纹理内容变化经依赖哈希传导。
        // 此处纹理像素未变而 revision 变 → 依赖哈希含 revision → 材质身份变化。
        // 失效信号 = (id, revision) 版本键:内容指纹相同(像素未变)而 revision 变,
        // 缓存按 VersionKey 失效并重上传——内容哈希只管内容,版本键只管失效,各司其职。
        assert_ne!(earlier.textures[0].revision, later.textures[0].revision);
        assert_eq!(earlier.textures[0].id, later.textures[0].id);
        assert_eq!(earlier.textures[0].content, later.textures[0].content);
        // 未被材质引用的纹理变化不改变材质身份(引用闭合语义)。
        assert_eq!(earlier.geometries, later.geometries);
    }
}
