use std::collections::{HashMap, HashSet};

use crate::{contract::RenderPacket, shader_package::DeepShaderPackageV2};

use super::{RuntimeMaterialShaderBinding, RuntimePackageError, fail};

pub(super) fn validate(
    bindings: &[RuntimeMaterialShaderBinding],
    packet: &RenderPacket,
    shaders: &[DeepShaderPackageV2],
) -> Result<(), RuntimePackageError> {
    if bindings.is_empty() || bindings.len() > 16_384 {
        return fail("runtime package v2 requires 1..=16384 material bindings");
    }
    let materials: HashSet<_> = packet
        .materials
        .iter()
        .map(|value| value.id.as_str())
        .collect();
    let shaders: HashMap<_, _> = shaders
        .iter()
        .map(|value| (value.package_id.as_str(), value))
        .collect();
    let mut used = HashSet::new();
    let mut previous: Option<&str> = None;
    for binding in bindings {
        let material = binding.material_id.as_str();
        if material.is_empty()
            || material.len() > 256
            || binding.technique_id.is_empty()
            || binding.technique_id.len() > 128
        {
            return fail("invalid material binding identity or technique");
        }
        if previous.is_some_and(|id| id >= material) {
            return fail("material bindings must be sorted by unique material id");
        }
        previous = Some(material);
        if !materials.contains(material) {
            return fail(format!(
                "material binding refers to absent material {material:?}"
            ));
        }
        let Some(shader) = shaders.get(binding.package_id.as_str()) else {
            return fail(format!(
                "material {material:?} refers to an absent shader package"
            ));
        };
        if shader.shader_abi.id != "deep.pbr.mesh.v2" {
            return fail("executable materials require CSM shader ABI deep.pbr.mesh.v2");
        }
        if !shader
            .passes
            .iter()
            .any(|pass| pass.technique_id == binding.technique_id && pass.kind == "forward")
        {
            return fail(format!(
                "material {material:?} technique has no forward pass"
            ));
        }
        used.insert(binding.package_id.as_str());
    }
    if used.len() != shaders.len() {
        return fail("every shader entrypoint must be bound to a material");
    }
    Ok(())
}
