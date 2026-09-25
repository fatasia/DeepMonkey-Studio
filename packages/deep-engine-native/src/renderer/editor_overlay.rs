//! Browser editor triangles. The author owns projection; the player only draws
//! the validated clip-space stream after tone mapping, without depth testing.

use wgpu::util::DeviceExt;

pub(super) const MAX_VERTICES: usize = 196_608;

pub(super) fn validate(vertices: &[f32]) -> Result<(), String> {
    if vertices.len() % 24 != 0 || vertices.len() > MAX_VERTICES * 8 {
        return Err("WASM editor overlay layout or vertex budget is invalid".into());
    }
    for (index, value) in vertices.iter().enumerate() {
        if !value.is_finite() || (index % 8 >= 4 && !(0.0..=1.0).contains(value)) {
            return Err("WASM editor overlay requires finite positions and unit colors".into());
        }
    }
    Ok(())
}

pub(super) struct EditorOverlay {
    pipeline: wgpu::RenderPipeline,
    buffer: Option<wgpu::Buffer>,
    vertex_count: u32,
    revision: Option<u64>,
}

impl EditorOverlay {
    pub(super) fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let convert_srgb = format.is_srgb();
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep WASM editor overlay"),
            source: wgpu::ShaderSource::Wgsl(format!(r#"
struct Vertex {{ @builtin(position) position: vec4f, @location(0) color: vec4f }};
@vertex fn vs(@location(0) position: vec4f, @location(1) color: vec4f) -> Vertex {{
  var out: Vertex; out.position = position; out.color = color; return out;
}}
@fragment fn fs(input: Vertex) -> @location(0) vec4f {{
  var color = input.color.rgb;
  {}
  return vec4f(color * input.color.a, input.color.a);
}}
"#, if convert_srgb {
                "color = select(pow((color + 0.055) / 1.055, vec3f(2.4)), color / 12.92, color <= vec3f(0.04045));"
            } else { "" }).into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Deep WASM editor overlay"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 32,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x4,
                            offset: 0,
                            shader_location: 0,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x4,
                            offset: 16,
                            shader_location: 1,
                        },
                    ],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        Self {
            pipeline,
            buffer: None,
            vertex_count: 0,
            revision: None,
        }
    }

    pub(super) fn update(
        &mut self,
        device: &wgpu::Device,
        vertices: &[f32],
        revision: u64,
    ) -> Result<(), String> {
        validate(vertices)?;
        if self.revision.is_some_and(|previous| revision < previous) {
            return Err("WASM editor overlay revision went backwards".into());
        }
        self.buffer = (!vertices.is_empty()).then(|| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep WASM editor overlay vertices"),
                contents: bytemuck::cast_slice(vertices),
                usage: wgpu::BufferUsages::VERTEX,
            })
        });
        self.vertex_count = (vertices.len() / 8) as u32;
        self.revision = Some(revision);
        Ok(())
    }

    pub(super) fn encode(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) {
        let Some(buffer) = self.buffer.as_ref() else {
            return;
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep WASM editor overlay"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_vertex_buffer(0, buffer.slice(..));
        pass.draw(0..self.vertex_count, 0..1);
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_VERTICES, validate};
    #[test]
    fn overlay_layout_and_budget_fail_closed() {
        assert!(validate(&[]).is_ok());
        assert!(validate(&vec![0.5; 24]).is_ok());
        assert!(validate(&vec![0.5; MAX_VERTICES * 8 + 24]).is_err());
        assert!(validate(&[0.0]).is_err());
        let mut bad = vec![0.5; 24];
        bad[4] = 1.1;
        assert!(validate(&bad).is_err());
        bad[4] = 0.5;
        bad[0] = f32::NAN;
        assert!(validate(&bad).is_err());
    }
}
