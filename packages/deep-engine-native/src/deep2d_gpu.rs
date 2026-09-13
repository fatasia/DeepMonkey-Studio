use bytemuck::cast_slice;
use deep_engine_native::deep2d::{
    Deep2dRuntimeContent, PreparedDeep2d, PreparedDeep2dChunk, PreparedDeep2dChunkKind,
    PreparedDeep2dRuntimeSummary, prepare_runtime_content,
};
use wgpu::util::DeviceExt;

use crate::deep2d_atlas_gpu::Deep2dAtlasGpuResources;

const SHADER: &str = include_str!("../assets/shaders/native_deep2d_v1.wgsl");

struct Deep2dPathGpuResources {
    pipeline: wgpu::RenderPipeline,
    vertex_buffer: wgpu::Buffer,
}

pub struct Deep2dGpuPainter {
    path: Option<Deep2dPathGpuResources>,
    atlas: Option<Deep2dAtlasGpuResources>,
    frame_bind_group: wgpu::BindGroup,
    chunks: Vec<PreparedDeep2dChunk>,
    pub summary: PreparedDeep2dRuntimeSummary,
}

impl Deep2dGpuPainter {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        content: &Deep2dRuntimeContent,
    ) -> Result<Self, String> {
        let prepared = prepare_runtime_content(content)?;
        let frame_layout = frame_layout(device);
        let path = (!prepared.path.vertices.is_empty())
            .then(|| Deep2dPathGpuResources::new(device, format, &frame_layout, &prepared.path));
        let atlas = (!prepared.atlas_vertices.is_empty())
            .then(|| Deep2dAtlasGpuResources::new(device, queue, format, &frame_layout, &prepared))
            .transpose()?;
        let frame = [[
            prepared.path.logical_width,
            prepared.path.logical_height,
            0.0,
            0.0,
        ]];
        let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native Deep2d frame"),
            contents: cast_slice(&frame),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native Deep2d frame bindings"),
            layout: &frame_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: frame_buffer.as_entire_binding(),
            }],
        });
        Ok(Self {
            path,
            atlas,
            frame_bind_group,
            chunks: prepared.chunks,
            summary: prepared.summary,
        })
    }

    pub fn draw(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) {
        if self.chunks.is_empty() {
            return;
        }
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native Deep2d ordered pass v2"),
            color_attachments: &color_attachments,
            depth_stencil_attachment: None,
            ..Default::default()
        });
        pass.set_bind_group(0, &self.frame_bind_group, &[]);
        for chunk in &self.chunks {
            match chunk.kind {
                PreparedDeep2dChunkKind::Path => {
                    let path = self.path.as_ref().expect("prepared path resource");
                    pass.set_pipeline(&path.pipeline);
                    pass.set_vertex_buffer(0, path.vertex_buffer.slice(..));
                }
                PreparedDeep2dChunkKind::Atlas { atlas_index } => {
                    let atlas = self.atlas.as_ref().expect("prepared atlas resource");
                    pass.set_pipeline(&atlas.pipeline);
                    pass.set_vertex_buffer(0, atlas.vertex_buffer.slice(..));
                    pass.set_bind_group(1, &atlas.atlases[atlas_index].bind_group, &[]);
                }
            }
            pass.draw(
                chunk.first_vertex..chunk.first_vertex + chunk.vertex_count,
                0..1,
            );
        }
    }
}

impl Deep2dPathGpuResources {
    fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        frame_layout: &wgpu::BindGroupLayout,
        prepared: &PreparedDeep2d,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native Deep2d shader v1"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Deep Engine native Deep2d pipeline layout"),
            bind_group_layouts: &[Some(frame_layout)],
            immediate_size: 0,
        });
        let attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4];
        let buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: 24,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &attributes,
        })];
        let targets = [Some(wgpu::ColorTargetState {
            format,
            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::ALL,
        })];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Deep Engine native Deep2d alpha pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &buffers,
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment_main"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview_mask: None,
            cache: None,
        });
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native Deep2d vertices"),
            contents: cast_slice(&prepared.vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
        Self {
            pipeline,
            vertex_buffer,
        }
    }
}

fn frame_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native Deep2d frame layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    })
}
