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
        let selected_uvs = [
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
        Self {
            requires_uv0: selected_uvs.contains(&Some(0)),
            requires_uv1: selected_uvs.contains(&Some(1)),
            normal_mapped: material.normal_texture.is_some(),
        }
    }
}
