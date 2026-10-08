//! RIS material input from the same opaque/MASK geometry, textures and normals.
//! Allocated only after a RIS decision; uses the main depth with Equal and never
//! renders custom/layered materials through a different material ABI.
use crate::{
    gpu_culling::GpuCulling, gpu_lod::GpuLod, gpu_scene::GpuScene, gpu_scene_draw::DrawFrame,
    pipeline::MeshPipelines,
};
use deep_engine_native::mesh_abi::{FORWARD_COLOR_FORMAT, FORWARD_SAMPLE_COUNT};

pub(super) struct MegaLightsGBuffer {
    _textures: [wgpu::Texture; 4],
    pub base_metal: wgpu::TextureView,
    pub normal_rough: wgpu::TextureView,
    base_msaa: wgpu::TextureView,
    normal_msaa: wgpu::TextureView,
    pipelines: MeshPipelines,
    pub dimensions: (u32, u32),
    pub epoch: u64,
}

impl MegaLightsGBuffer {
    pub fn create(
        device: &wgpu::Device,
        frame_layout: &wgpu::BindGroupLayout,
        material_layout: &wgpu::BindGroupLayout,
        width: u32,
        height: u32,
        epoch: u64,
    ) -> Self {
        let make = |format, samples, label| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: samples,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | if samples == 1 {
                        wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC
                    } else {
                        wgpu::TextureUsages::empty()
                    },
                view_formats: &[],
            })
        };
        let normal_format = crate::forward_targets::NORMAL_CAPTURE_FORMAT;
        let textures = [
            make(FORWARD_COLOR_FORMAT, 1, "MegaLights base/metal"),
            make(
                FORWARD_COLOR_FORMAT,
                FORWARD_SAMPLE_COUNT,
                "MegaLights base/metal MSAA",
            ),
            make(normal_format, 1, "MegaLights normal/roughness"),
            make(
                normal_format,
                FORWARD_SAMPLE_COUNT,
                "MegaLights normal/roughness MSAA",
            ),
        ];
        let source = deep_engine_native::native_mesh_wgsl::native_mesh_shader_source()
            + include_str!("../../assets/shaders/native_megalights_gbuffer.wgsl");
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("MegaLights actual material shader"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
        Self {
            base_metal: textures[0].create_view(&Default::default()),
            base_msaa: textures[1].create_view(&Default::default()),
            normal_rough: textures[2].create_view(&Default::default()),
            normal_msaa: textures[3].create_view(&Default::default()),
            _textures: textures,
            pipelines: crate::pipeline::create_megalights_gbuffer_pipelines(
                device,
                frame_layout,
                material_layout,
                &shader,
            ),
            dimensions: (width, height),
            epoch,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        depth: &wgpu::TextureView,
        frame: &wgpu::BindGroup,
        scene: &GpuScene,
        culling: &GpuCulling,
        lod: Option<&GpuLod>,
    ) {
        let attachments = [
            (&self.base_msaa, &self.base_metal),
            (&self.normal_msaa, &self.normal_rough),
        ]
        .map(|(view, resolve)| {
            Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: Some(resolve),
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Discard,
                },
            })
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("MegaLights actual opaque material GBuffer"),
            color_attachments: &attachments,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: depth,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_bind_group(0, frame, &[]);
        scene.draw_solid_indirect(
            &mut pass,
            &self.pipelines,
            culling,
            lod,
            DrawFrame {
                builtin: frame,
                cascade: None,
            },
        );
    }
}
