#[path = "pipeline/mesh.rs"]
mod mesh;
#[path = "pipeline/raster.rs"]
mod raster;
#[path = "pipeline/shadow.rs"]
mod shadow;

use deep_engine_native::{contract::AlphaMode, shadow_cache::ShadowCasterMode};

pub const MESH_PIPELINE_VARIANTS: usize = 12;
pub const SHADOW_PIPELINE_VARIANTS: usize = 9;

pub struct MeshPipelines {
    solid: MaterialPipelines,
    blend: MaterialPipelines,
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
    pub fn select(
        &self,
        alpha_mode: AlphaMode,
        mirrored: bool,
        double_sided: bool,
        normal_mapped: bool,
    ) -> &wgpu::RenderPipeline {
        let set = if alpha_mode == AlphaMode::Blend {
            &self.blend
        } else {
            &self.solid
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
        match mode {
            ShadowCasterMode::Solid => (self.shadow.solid.select(mirrored, double_sided), false),
            ShadowCasterMode::MaskPlain => {
                (self.shadow.mask_plain.select(mirrored, double_sided), false)
            }
            ShadowCasterMode::MaskMaterial => (
                self.shadow.mask_material.select(mirrored, double_sided),
                true,
            ),
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
        solid: mesh::create_material_pipelines(
            device,
            frame_layout,
            material_layout,
            shader,
            false,
        ),
        blend: mesh::create_material_pipelines(device, frame_layout, material_layout, shader, true),
        shadow: shadow::create_shadow_pipelines(
            device,
            shadow_frame_layout,
            material_layout,
            shader,
        ),
    }
}
