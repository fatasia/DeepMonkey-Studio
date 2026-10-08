use std::{cell::RefCell, collections::HashMap};

const SHADER: &str = r#"
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> Vertex {
  let point = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[index];
  return Vertex(vec4f(point, 0.0, 1.0), vec2f(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5));
}
@fragment fn fs(input: Vertex) -> @location(0) vec4f {
  return textureSampleLevel(image, linearSampler, input.uv, 0.0);
}
"#;

/// Lives with the device scene cache; no pipeline creation for textures with authored mips.
#[derive(Default)]
pub struct TextureMipGenerator {
    pipelines: RefCell<HashMap<wgpu::TextureFormat, (wgpu::RenderPipeline, wgpu::Sampler)>>,
}
impl TextureMipGenerator {
    pub fn generate(&self, device: &wgpu::Device, queue: &wgpu::Queue,
        texture: &wgpu::Texture, format: wgpu::TextureFormat, count: u32) {
        if count <= 1 { return; }
        let mut pipelines = self.pipelines.borrow_mut();
        let (pipeline, sampler) = pipelines.entry(format).or_insert_with(|| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Deep texture mip shader"), source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Deep texture mip pipeline"), layout: None,
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"),
                    compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"),
                    compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState {
                        format, blend: None, write_mask: wgpu::ColorWrites::ALL,
                    })] }),
                primitive: Default::default(), depth_stencil: None, multisample: Default::default(),
                multiview_mask: None, cache: None,
            });
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("Deep mip linear sampler"), min_filter: wgpu::FilterMode::Linear,
                mag_filter: wgpu::FilterMode::Linear, ..Default::default()
            });
            (pipeline, sampler)
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Deep texture mip generation"),
        });
        for level in 1..count {
            let source = texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level - 1, mip_level_count: Some(1), ..Default::default()
            });
            let target = texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level, mip_level_count: Some(1), ..Default::default()
            });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Deep mip source"), layout: &pipeline.get_bind_group_layout(0), entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&source) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                ],
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Deep mip pass"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })], depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
            });
            pass.set_pipeline(pipeline); pass.set_bind_group(0, &group, &[]); pass.draw(0..3, 0..1);
        }
        queue.submit([encoder.finish()]);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::gpu_scene_cache_test_support::{high_performance_device, push_scopes, clean_scopes};

    #[test]
    #[ignore = "requires a physical GPU"]
    fn generated_texture_mips_filter_linear_light_and_preserve_orientation() {
        pollster::block_on(async {
            let (device, queue) = high_performance_device().await;
            let scopes = push_scopes(&device);
            let generator = TextureMipGenerator::default();
            for (format, expected) in [(wgpu::TextureFormat::Rgba8Unorm, 128u8),
                (wgpu::TextureFormat::Rgba8UnormSrgb, 188u8)] {
                let texture = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("mip test"), size: wgpu::Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
                    mip_level_count: 3, sample_count: 1, dimension: wgpu::TextureDimension::D2, format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC, view_formats: &[],
                });
                let pixels = (0..16).flat_map(|index| {
                    let value = if index < 8 { 0 } else { 255 }; [value, value, value, 128]
                }).collect::<Vec<_>>();
                queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0,
                    origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, &pixels,
                    wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(16), rows_per_image: Some(4) },
                    wgpu::Extent3d { width: 4, height: 4, depth_or_array_layers: 1 });
                generator.generate(&device, &queue, &texture, format, 3);
                let buffer = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 768,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
                let mut encoder = device.create_command_encoder(&Default::default());
                for (level, offset, size) in [(1, 0, 2), (2, 512, 1)] {
                    encoder.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: level,
                        origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout {
                            offset, bytes_per_row: Some(256), rows_per_image: Some(size),
                        } }, wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 });
                }
                queue.submit([encoder.finish()]);
                let (send, recv) = std::sync::mpsc::sync_channel(1);
                buffer.map_async(wgpu::MapMode::Read, .., move |result| { send.send(result).unwrap(); });
                device.poll(wgpu::PollType::wait_indefinitely()).unwrap(); recv.recv().unwrap().unwrap();
                let bytes = buffer.get_mapped_range(..).unwrap();
                assert_eq!(&bytes[0..4], &[0, 0, 0, 128]);
                assert_eq!(&bytes[256..260], &[255, 255, 255, 128]);
                assert!(bytes[512].abs_diff(expected) <= 1, "{format:?}: {}", bytes[512]);
                assert_eq!(bytes[515], 128);
                drop(bytes); buffer.unmap();
            }
            assert_eq!(generator.pipelines.borrow().len(), 2);
            clean_scopes(scopes, "generated mips").await;
        });
    }
}
