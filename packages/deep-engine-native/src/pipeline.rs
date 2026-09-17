#[path = "pipeline/mesh.rs"]
mod mesh;
#[path = "pipeline/raster.rs"]
mod raster;
#[path = "pipeline/shadow.rs"]
mod shadow;

use deep_engine_native::{contract::AlphaMode, shadow_cache::ShadowCasterMode};
use mesh::BlendSemantic;

pub const MESH_PIPELINE_VARIANTS: usize = 18;
pub const SHADOW_PIPELINE_VARIANTS: usize = 9;

pub struct MeshPipelines {
    active: Option<ActiveMeshPipelines>,
}

struct ActiveMeshPipelines {
    solid: MaterialPipelines,
    blend: MaterialPipelines,
    blend_premultiplied: MaterialPipelines,
    shadow: ShadowPipelines,
}

struct MaterialPipelines {
    standard: RasterPipelines,
    normal_mapped: RasterPipelines,
}

struct RasterPipelines {
    regular: wgpu::RenderPipeline,
    mirrored: wgpu::RenderPipeline,
    double_sided: wgpu::RenderPipeline,
}

struct ShadowPipelines {
    solid: RasterPipelines,
    mask_plain: RasterPipelines,
    mask_material: RasterPipelines,
}

impl RasterPipelines {
    fn select(&self, mirrored: bool, double_sided: bool) -> &wgpu::RenderPipeline {
        if double_sided {
            &self.double_sided
        } else if mirrored {
            &self.mirrored
        } else {
            &self.regular
        }
    }
}

impl MeshPipelines {
    pub fn for_empty_scene() -> Self {
        Self { active: None }
    }

    pub fn counts(&self) -> (usize, usize) {
        if self.active.is_some() {
            (MESH_PIPELINE_VARIANTS, SHADOW_PIPELINE_VARIANTS)
        } else {
            (0, 0)
        }
    }

    pub fn select(
        &self,
        alpha_mode: AlphaMode,
        premultiplied: bool,
        mirrored: bool,
        double_sided: bool,
        normal_mapped: bool,
    ) -> &wgpu::RenderPipeline {
        let active = self
            .active
            .as_ref()
            .expect("scene draws require material pipelines");
        // DE26/C03:premultiplied 是独立管线变体(RGB blend 因子 one),不与 solid/straight 混用。
        let set = if alpha_mode == AlphaMode::Blend {
            if premultiplied {
                &active.blend_premultiplied
            } else {
                &active.blend
            }
        } else {
            &active.solid
        };
        let set = if normal_mapped {
            &set.normal_mapped
        } else {
            &set.standard
        };
        set.select(mirrored, double_sided)
    }

    pub fn select_shadow(
        &self,
        mode: ShadowCasterMode,
        mirrored: bool,
        double_sided: bool,
    ) -> (&wgpu::RenderPipeline, bool) {
        let shadow = &self
            .active
            .as_ref()
            .expect("shadow draws require material pipelines")
            .shadow;
        match mode {
            ShadowCasterMode::Solid => (shadow.solid.select(mirrored, double_sided), false),
            ShadowCasterMode::MaskPlain => {
                (shadow.mask_plain.select(mirrored, double_sided), false)
            }
            ShadowCasterMode::MaskMaterial => {
                (shadow.mask_material.select(mirrored, double_sided), true)
            }
        }
    }
}

pub fn create_mesh_pipelines(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    shadow_frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
) -> MeshPipelines {
    MeshPipelines {
        active: Some(ActiveMeshPipelines {
            solid: mesh::create_material_pipelines(
                device,
                frame_layout,
                material_layout,
                shader,
                BlendSemantic::Solid,
            ),
            blend: mesh::create_material_pipelines(
                device,
                frame_layout,
                material_layout,
                shader,
                BlendSemantic::Straight,
            ),
            blend_premultiplied: mesh::create_material_pipelines(
                device,
                frame_layout,
                material_layout,
                shader,
                BlendSemantic::Premultiplied,
            ),
            shadow: shadow::create_shadow_pipelines(
                device,
                shadow_frame_layout,
                material_layout,
                shader,
            ),
        }),
    }
}
