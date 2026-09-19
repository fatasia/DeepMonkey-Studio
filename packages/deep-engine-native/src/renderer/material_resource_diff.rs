//! C3 material/texture incremental classification.
//!
//! Uniform-only material changes can update the existing bind-group buffer;
//! texture-slot or shader-feature changes must fall back to resource staging.

use deep_engine_native::{contract::PbrMaterial, pbr_texture::{prepare_material_uniform, PreparedMaterial}};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterialResourceDiff {
    Identical,
    UniformOnly { changed_indices: Vec<usize> },
    Structural,
}

pub fn classify_material_resources(
    before: &[PreparedMaterial],
    after: &[PreparedMaterial],
) -> MaterialResourceDiff {
    if before.len() != after.len() {
        return MaterialResourceDiff::Structural;
    }
    let mut changed = Vec::new();
    for (index, (old, new)) in before.iter().zip(after.iter()).enumerate() {
        if old.texture_indices != new.texture_indices || old.normal_mapped != new.normal_mapped {
            return MaterialResourceDiff::Structural;
        }
        if old.uniform != new.uniform {
            changed.push(index);
        }
    }
    if changed.is_empty() {
        MaterialResourceDiff::Identical
    } else {
        MaterialResourceDiff::UniformOnly { changed_indices: changed }
    }
}

/// A conservative pre-prepare check: changes to texture references or shader
/// feature fields are structural; numeric material values are uniform-only.
pub fn material_contract_is_uniform_only(before: &PbrMaterial, after: &PbrMaterial) -> bool {
    before.id == after.id
        && before.shading_model == after.shading_model
        && format!("{:?}", before.base_color_texture) == format!("{:?}", after.base_color_texture)
        && format!("{:?}", before.metallic_roughness_texture) == format!("{:?}", after.metallic_roughness_texture)
        && format!("{:?}", before.normal_texture) == format!("{:?}", after.normal_texture)
        && format!("{:?}", before.occlusion_texture) == format!("{:?}", after.occlusion_texture)
        && format!("{:?}", before.emissive_texture) == format!("{:?}", after.emissive_texture)
        && before.alpha_mode == after.alpha_mode
        && before.double_sided == after.double_sided
        && before.premultiplied_alpha == after.premultiplied_alpha
}

/// Build the uniform payload only after the structural contract passes.
pub fn uniform_payload(material: &PbrMaterial) -> Result<[f32; deep_engine_native::mesh_abi::MATERIAL_UNIFORM_FLOATS], String> {
    prepare_material_uniform(material)
}

#[cfg(test)]
mod tests {
    use super::*;
    use deep_engine_native::pbr_texture::PreparedMaterial;

    fn prepared(uniform: f32) -> PreparedMaterial {
        PreparedMaterial {
            id: "m".into(),
            normal_mapped: false,
            texture_indices: [None; 5],
            uniform: [uniform; 40],
        }
    }

    #[test]
    fn classifies_uniform_only_changes() {
        assert_eq!(classify_material_resources(&[prepared(0.0)], &[prepared(1.0)]), MaterialResourceDiff::UniformOnly { changed_indices: vec![0] });
    }

    #[test]
    fn classifies_identical_and_structural() {
        assert_eq!(classify_material_resources(&[prepared(0.0)], &[prepared(0.0)]), MaterialResourceDiff::Identical);
        let mut changed = prepared(0.0);
        changed.texture_indices[0] = Some(2);
        assert_eq!(classify_material_resources(&[prepared(0.0)], &[changed]), MaterialResourceDiff::Structural);
    }
}
