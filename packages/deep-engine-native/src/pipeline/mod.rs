#[path = "mesh.rs"]
mod mesh;
#[path = "raster.rs"]
mod raster;
#[path = "rt.rs"]
mod rt;
#[path = "shadow.rs"]
mod shadow;

// create_rt_mesh_pipelines 仅在含 renderer/init 的目标被消费;部分窄特性
// 测试目标只取 RtMeshPipelines,故对整行放行 unused_imports。
#[allow(unused_imports)]
pub(crate) use rt::{
    RtMeshPipelines, create_rt_mesh_pipelines, create_rt_mesh_pipelines_with_layered,
};

use deep_engine_native::{contract::AlphaMode, shadow_cache::ShadowCasterMode};
use mesh::BlendSemantic;

pub const MESH_PIPELINE_VARIANTS: usize = 18;
pub const SHADOW_PIPELINE_VARIANTS: usize = 9;

pub struct MeshPipelines {
    active: Option<ActiveMeshPipelines>,
    /// I-C23 分层颜色管线族:仅当分层能力可用(片段采样纹理 ≥ 19 合同)且
    /// 调用方请求时驻留;shadow/outline 永远走普通族(层不影响阴影/轮廓 ABI)。
    layered: Option<LayeredColorPipelines>,
}

struct ActiveMeshPipelines {
    solid: MaterialPipelines,
    blend: MaterialPipelines,
    blend_premultiplied: MaterialPipelines,
    shadow: Option<ShadowPipelines>,
}

struct LayeredColorPipelines {
    solid: MaterialPipelines,
    blend: MaterialPipelines,
    blend_premultiplied: MaterialPipelines,
}

#[derive(Clone)]
struct MaterialPipelines {
    standard: RasterPipelines,
    normal_mapped: RasterPipelines,
}

#[derive(Clone)]
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
        Self {
            active: None,
            layered: None,
        }
    }

    pub fn counts(&self) -> (usize, usize) {
        if self.active.is_some() {
            if self.active.as_ref().is_some_and(|p| p.shadow.is_some()) {
                (MESH_PIPELINE_VARIANTS, SHADOW_PIPELINE_VARIANTS)
            } else { (6, 0) }
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

    /// I-C23:分层批次的颜色管线选择,选择轴与 `select` 完全同构;仅入口与
    /// 材质 layout 不同。分层族未驻留时返回 None,由 draw 侧回落普通族
    /// (分层能力不可用的设备上调用方不得让分层材质进场景——见 init 门)。
    pub fn select_layered(
        &self,
        alpha_mode: AlphaMode,
        premultiplied: bool,
        mirrored: bool,
        double_sided: bool,
        normal_mapped: bool,
    ) -> Option<&wgpu::RenderPipeline> {
        let layered = self.layered.as_ref()?;
        let set = if alpha_mode == AlphaMode::Blend {
            if premultiplied {
                &layered.blend_premultiplied
            } else {
                &layered.blend
            }
        } else {
            &layered.solid
        };
        let set = if normal_mapped {
            &set.normal_mapped
        } else {
            &set.standard
        };
        Some(set.select(mirrored, double_sided))
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
            .shadow.as_ref().expect("GBuffer pipelines do not draw shadow passes");
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
    create_mesh_pipelines_with_normal_capture(
        device,
        frame_layout,
        shadow_frame_layout,
        material_layout,
        shader,
        false,
    )
}

/// Same pipeline budget; only opaque entrypoints gain a second attachment when explicitly requested.
pub fn create_mesh_pipelines_with_normal_capture(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    shadow_frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    capture: bool,
) -> MeshPipelines {
    MeshPipelines {
        active: Some(ActiveMeshPipelines {
            solid: mesh::create_material_pipelines(
                device,
                frame_layout,
                material_layout,
                shader,
                BlendSemantic::Solid,
                capture,
            ),
            blend: mesh::create_material_pipelines(
                device,
                frame_layout,
                material_layout,
                shader,
                BlendSemantic::Straight,
                false,
            ),
            blend_premultiplied: mesh::create_material_pipelines(
                device,
                frame_layout,
                material_layout,
                shader,
                BlendSemantic::Premultiplied,
                false,
            ),
            shadow: Some(shadow::create_shadow_pipelines(
                device,
                shadow_frame_layout,
                material_layout,
                shader,
            )),
        }),
        layered: None,
    }
}

/// Six opaque/MASK raster variants; shares the normal material/instance ABI.
pub(crate) fn create_megalights_gbuffer_pipelines(
    device: &wgpu::Device, frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout, shader: &wgpu::ShaderModule,
) -> MeshPipelines {
    let solid = mesh::create_megalights_material_pipelines(device, frame_layout, material_layout, shader);
    MeshPipelines { active: Some(ActiveMeshPipelines {
        blend: solid.clone(), blend_premultiplied: solid.clone(), solid, shadow: None,
    }), layered: None }
}

/// I-C23:在普通管线族之上追加分层颜色管线族(fragment_*_layered 入口 +
/// 扩展材质 layout)。分层族不驻留时 draw 侧不得使用分层材质(init 门负责)。
pub fn create_mesh_pipelines_with_layered(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    shadow_frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    layered_material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
) -> MeshPipelines {
    let mut pipelines = create_mesh_pipelines(
        device,
        frame_layout,
        shadow_frame_layout,
        material_layout,
        shader,
    );
    pipelines.layered = Some(LayeredColorPipelines {
        solid: mesh::create_layered_material_pipelines(
            device,
            frame_layout,
            layered_material_layout,
            shader,
            BlendSemantic::Solid,
            false,
        ),
        blend: mesh::create_layered_material_pipelines(
            device,
            frame_layout,
            layered_material_layout,
            shader,
            BlendSemantic::Straight,
            false,
        ),
        blend_premultiplied: mesh::create_layered_material_pipelines(
            device,
            frame_layout,
            layered_material_layout,
            shader,
            BlendSemantic::Premultiplied,
            false,
        ),
    });
    pipelines
}
