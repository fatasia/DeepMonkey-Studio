use std::collections::HashMap;

use deep_engine_native::{
    contract::{AlphaMode, RenderPacket},
    pbr_texture::prepare_pbr_resources,
    runtime_package::RuntimeMaterialShaderBinding,
    scene::{DrawBatch, prepare_scene},
    shader_package::{DeepShaderPackageV2, ShaderPackagePass},
};

#[derive(Clone, Copy)]
pub struct ShaderMaterialFeatures {
    pub normal_mapped: bool,
    pub textured: bool,
    pub base_color_mapped: bool,
}

#[derive(Clone, Debug)]
pub struct MaterialShaderPlan {
    pub package_index: usize,
    pub forward: [Option<String>; 3],
    pub shadow: [Option<String>; 3],
}

pub fn raster_slot(batch: &DrawBatch) -> usize {
    if batch.double_sided {
        2
    } else {
        usize::from(batch.mirrored)
    }
}

pub fn plan_shader_materials(
    packet: &RenderPacket,
    packages: &[DeepShaderPackageV2],
    bindings: &[RuntimeMaterialShaderBinding],
) -> Result<Vec<Option<MaterialShaderPlan>>, String> {
    let scene = prepare_scene(packet)?;
    let pbr = prepare_pbr_resources(packet)?;
    let features: Vec<_> = pbr
        .materials
        .iter()
        .map(|material| ShaderMaterialFeatures {
            normal_mapped: material.normal_mapped,
            textured: material.texture_indices.iter().any(Option::is_some),
            base_color_mapped: material.texture_indices[0].is_some(),
        })
        .collect();
    plan_shader_materials_prepared(packet, packages, bindings, &scene.batches, &features)
}

pub fn plan_shader_materials_prepared(
    packet: &RenderPacket,
    packages: &[DeepShaderPackageV2],
    bindings: &[RuntimeMaterialShaderBinding],
    batches: &[DrawBatch],
    features: &[ShaderMaterialFeatures],
) -> Result<Vec<Option<MaterialShaderPlan>>, String> {
    if features.len() != packet.materials.len() {
        return Err("native shader material features do not match the prepared scene".into());
    }
    let mut plans = vec![None; packet.materials.len()];
    let by_package: HashMap<_, _> = packages
        .iter()
        .enumerate()
        .map(|(index, package)| (package.package_id.as_str(), index))
        .collect();
    if by_package.len() != packages.len() {
        return Err("native Player shader package IDs must be unique".into());
    }
    let mut used = vec![false; packages.len()];
    for binding in bindings {
        let index = packet
            .materials
            .iter()
            .position(|material| material.id == binding.material_id)
            .ok_or_else(|| {
                format!(
                    "native shader binding references missing material {}",
                    binding.material_id
                )
            })?;
        if plans[index].is_some() {
            return Err(format!(
                "native material {} has duplicate shader bindings",
                binding.material_id
            ));
        }
        let package_index = *by_package.get(binding.package_id.as_str()).ok_or_else(|| {
            format!(
                "native material {} references missing shader package {}",
                binding.material_id, binding.package_id
            )
        })?;
        let package = &packages[package_index];
        if package.shader_abi.id != "deep.pbr.mesh.v2" {
            return Err(format!(
                "native material {} requires deep.pbr.mesh.v2 for four-cascade shadows; package {} uses {}",
                binding.material_id, binding.package_id, package.shader_abi.id
            ));
        }
        let material = &packet.materials[index];
        let prepared = &features[index];
        let alpha = match material.alpha_mode.unwrap_or(AlphaMode::Opaque) {
            AlphaMode::Opaque => "OPAQUE",
            AlphaMode::Mask => "MASK",
            AlphaMode::Blend => "BLEND",
        };
        let forward = if prepared.normal_mapped {
            vec!["forward-normal"]
        } else if prepared.textured {
            vec!["forward-material"]
        } else {
            vec!["forward-plain", "forward-material"]
        };
        let shadow = match alpha {
            "OPAQUE" => vec!["shadow-solid"],
            "MASK" if prepared.base_color_mapped => vec!["shadow-mask-material"],
            "MASK" => vec!["shadow-mask-plain", "shadow-mask-material"],
            _ => Vec::new(),
        };
        let mut plan = MaterialShaderPlan {
            package_index,
            forward: std::array::from_fn(|_| None),
            shadow: std::array::from_fn(|_| None),
        };
        let mut rasters = [false; 3];
        for batch in batches.iter().filter(|batch| batch.material_index == index) {
            rasters[raster_slot(batch)] = true;
        }
        // Uninstanced authored materials still need a valid executable configuration.
        if !rasters.iter().any(|value| *value) {
            rasters[if material.double_sided.unwrap_or(false) {
                2
            } else {
                0
            }] = true;
        }
        for (slot, raster) in ["ccw", "cw", "double"]
            .into_iter()
            .enumerate()
            .filter(|(slot, _)| rasters[*slot])
        {
            plan.forward[slot] = Some(
                select_pass(package, binding, "forward", alpha, raster, &forward)?
                    .id
                    .clone(),
            );
            if !shadow.is_empty() {
                plan.shadow[slot] = Some(
                    select_pass(package, binding, "shadow", alpha, raster, &shadow)?
                        .id
                        .clone(),
                );
            }
        }
        used[package_index] = true;
        plans[index] = Some(plan);
    }
    for (index, referenced) in used.into_iter().enumerate() {
        if !referenced {
            return Err(format!(
                "native shader entry {} has no material binding",
                packages[index].package_id
            ));
        }
    }
    Ok(plans)
}

fn select_pass<'a>(
    package: &'a DeepShaderPackageV2,
    binding: &RuntimeMaterialShaderBinding,
    kind: &str,
    alpha: &str,
    raster: &str,
    variants: &[&str],
) -> Result<&'a ShaderPackagePass, String> {
    for variant in variants {
        let matches: Vec<_> = package
            .passes
            .iter()
            .filter(|pass| {
                pass.technique_id == binding.technique_id
                    && pass.kind == kind
                    && pass.pipeline.alpha_mode == alpha
                    && pass.pipeline.raster_mode == raster
                    && pass.pipeline.pass_variant_id == *variant
            })
            .collect();
        if matches.len() == 1 {
            return Ok(matches[0]);
        }
        if matches.len() > 1 {
            return Err(format!(
                "native material {} shader package {} technique {} has ambiguous {kind} {alpha}/{raster}/{variant} passes",
                binding.material_id, binding.package_id, binding.technique_id
            ));
        }
    }
    Err(format!(
        "native material {} shader package {} technique {} lacks {kind} {alpha}/{raster} pass (required capability: {})",
        binding.material_id,
        binding.package_id,
        binding.technique_id,
        variants.join(" or ")
    ))
}

// Internal lifetime key. Hash bulk buffers as bytes; formatting millions of
// pixel values through Debug stalls the WASM input thread for seconds.
pub fn scene_content_key(packet: &RenderPacket) -> u64 {
    use std::fmt::Write;
    use std::hash::{DefaultHasher, Hasher};
    struct PacketDigest(DefaultHasher);
    impl Write for PacketDigest {
        fn write_str(&mut self, text: &str) -> std::fmt::Result {
            self.0.write(text.as_bytes());
            Ok(())
        }
    }
    let mut digest = PacketDigest(DefaultHasher::new());
    fn bytes(digest: &mut PacketDigest, data: &[u8]) {
        digest.0.write_usize(data.len());
        digest.0.write(data);
    }
    write!(
        &mut digest,
        "{:?}{:?}{:?}{:?}",
        packet.schema, packet.version, packet.materials, packet.instances
    )
    .expect("digest formatting cannot fail");
    digest.0.write_usize(packet.geometries.len());
    for geometry in &packet.geometries {
        write!(&mut digest, "{:?}{}", geometry.id, geometry.revision).unwrap();
        bytes(&mut digest, bytemuck::cast_slice(&geometry.vertices));
        bytes(&mut digest, bytemuck::cast_slice(&geometry.indices));
        for field in [
            &geometry.uv0,
            &geometry.uv1,
            &geometry.tangents,
            &geometry.colors,
        ] {
            digest.0.write_u8(u8::from(field.is_some()));
            if let Some(data) = field {
                bytes(&mut digest, bytemuck::cast_slice(data));
            }
        }
    }
    digest.0.write_usize(packet.textures.len());
    for texture in &packet.textures {
        write!(
            &mut digest,
            "{:?}{:?}{:?}{:?}{:?}{:?}{:?}",
            texture.id,
            texture.revision,
            texture.semantic,
            texture.width,
            texture.height,
            texture.bytes_per_row,
            texture.sampler
        )
        .unwrap();
        bytes(&mut digest, &texture.data);
        digest.0.write_usize(texture.mipmaps.len());
        for mip in &texture.mipmaps {
            write!(
                &mut digest,
                "{:?}{:?}{:?}",
                mip.width, mip.height, mip.bytes_per_row
            )
            .unwrap();
            bytes(&mut digest, &mip.data);
        }
    }
    digest.0.finish()
}

#[cfg(test)]
mod content_key_tests {
    use super::*;

    #[test]
    fn content_key_covers_bulk_buffers_and_resource_metadata() {
        let loaded = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
            include_bytes!("../tests/fixtures/runtime-package-v1.json"),
        )
        .unwrap();
        let mut source = loaded.render_packet;
        source.textures = vec![serde_json::from_str(r#"{"id":"color","revision":1,"semantic":"baseColor","width":1,"height":1,"data":[1,2,3,255]}"#).unwrap()];
        let key = scene_content_key(&source);
        assert_eq!(key, scene_content_key(&source.clone()));
        type PacketChange = Box<dyn Fn(&mut RenderPacket)>;
        let changes: Vec<PacketChange> = vec![
            Box::new(|p| p.geometries[0].vertices[0] += 0.25),
            Box::new(|p| p.geometries[0].indices.swap(0, 1)),
            Box::new(|p| p.geometries[0].uv1 = Some(vec![1.0, 2.0])),
            Box::new(|p| p.geometries[0].colors = Some(vec![1.0, 0.0, 0.0, 1.0])),
            Box::new(|p| p.textures[0].data[2] ^= 1),
            Box::new(|p| p.textures[0].width += 1),
            Box::new(|p| p.textures[0].revision += 1),
            Box::new(|p| p.materials[0].roughness += 0.1),
            Box::new(|p| p.instances[0].transform[12] += 1.0),
        ];
        for change in changes {
            let mut candidate = source.clone();
            change(&mut candidate);
            assert_ne!(key, scene_content_key(&candidate));
        }
    }
}
