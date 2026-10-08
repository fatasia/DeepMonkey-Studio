use super::{GeometryResource, PbrMaterial};

#[derive(Clone, Copy)]
pub(super) struct GeometryFeatures {
    pub uv0: bool,
    pub uv1: bool,
    pub tangents: bool,
}

impl GeometryFeatures {
    pub fn from_geometry(geometry: &GeometryResource) -> Self {
        Self {
            uv0: geometry.uv0.is_some(),
            uv1: geometry.uv1.is_some(),
            tangents: geometry.tangents.is_some(),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct MaterialFeatures {
    pub requires_uv0: bool,
    pub requires_uv1: bool,
    pub normal_mapped: bool,
}

impl MaterialFeatures {
    pub fn from_material(material: &PbrMaterial) -> Self {
        // Layer slots append at runtime, so the set stays a Vec (the base
        // slots contribute the initial five entries).
        let mut selected_uvs: Vec<Option<u8>> = vec![
            material
                .base_color_texture
                .as_ref()
                .map(|slot| slot.tex_coord.unwrap_or(0)),
            material
                .metallic_roughness_texture
                .as_ref()
                .map(|slot| slot.tex_coord.unwrap_or(0)),
            material
                .normal_texture
                .as_ref()
                .map(|slot| slot.tex_coord.unwrap_or(0)),
            material
                .occlusion_texture
                .as_ref()
                .map(|slot| slot.tex_coord.unwrap_or(0)),
            material
                .emissive_texture
                .as_ref()
                .map(|slot| slot.tex_coord.unwrap_or(0)),
        ];
        selected_uvs.extend([material.specular_texture.as_ref(),material.specular_color_texture.as_ref()]
            .into_iter().map(|slot|slot.map(|value|value.tex_coord.unwrap_or(0))));
        // I-C23 分层纹理槽参与同一 UV-set 需求合同:层槽声明 texCoord 1 时
        // 几何必须驻留 uv1(与基材槽同规则)。
        if let Some(layered) = &material.layered {
            for layer in &layered.layers {
                let Some(surface) = &layer.surface else {
                    continue;
                };
                for slot in [
                    surface.base_color_texture.as_ref(),
                    surface.metallic_roughness_texture.as_ref(),
                ]
                .into_iter()
                .flatten()
                {
                    selected_uvs.push(Some(slot.tex_coord.unwrap_or(0)));
                }
            }
        }
        Self {
            requires_uv0: selected_uvs.contains(&Some(0)),
            requires_uv1: selected_uvs.contains(&Some(1)),
            normal_mapped: material.normal_texture.is_some(),
        }
    }
}
