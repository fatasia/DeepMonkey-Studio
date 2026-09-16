use crate::hdr_readback::half_to_f32;
use std::sync::mpsc;

use deep_engine_native::{mesh_abi::SHADOW_FORMAT, shadow_cache::ShadowVersion};
use winit::dpi::PhysicalSize;

use crate::{gpu_ibl::GpuIblEnvironment, shadow_map::ShadowMap};

const BYTES_PER_PIXEL: u32 = 8;

#[derive(Clone, Copy, Debug)]
pub struct ShadowProbeMetrics {
    pub changed_pixels: usize,
    pub shadowed_luminance: f64,
    pub unshadowed_luminance: f64,
    pub shadow_effect_hash: u64,
    pub version: ShadowVersion,
}

pub struct ShadowProbe {
    _unshadowed_texture: wgpu::Texture,
    unshadowed_layer_views: Vec<wgpu::TextureView>,
    disabled_frame_bind_group: wgpu::BindGroup,
    shadowed_readback: wgpu::Buffer,
    unshadowed_readback: wgpu::Buffer,
    width: u32,
    height: u32,
    padded_bytes_per_row: u32,
}

impl ShadowProbe {
    pub fn new(
        device: &wgpu::Device,
        frame_layout: &wgpu::BindGroupLayout,
        shadow_map: &ShadowMap,
        frame_buffer: &wgpu::Buffer,
        ibl: &GpuIblEnvironment,
        size: PhysicalSize<u32>,
    ) -> Self {
        let unshadowed_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native all-lit shadow probe texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: shadow_map.cascade_count(),
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: SHADOW_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let unshadowed_view = unshadowed_texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("Deep Engine native all-lit shadow probe array view"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            array_layer_count: Some(shadow_map.cascade_count()),
            aspect: wgpu::TextureAspect::DepthOnly,
            ..Default::default()
        });
        let unshadowed_layer_views = (0..shadow_map.cascade_count())
            .map(|layer| {
                unshadowed_texture.create_view(&wgpu::TextureViewDescriptor {
                    label: Some("Deep Engine native all-lit probe layer"),
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: layer,
                    array_layer_count: Some(1),
                    aspect: wgpu::TextureAspect::DepthOnly,
                    ..Default::default()
                })
            })
            .collect();
        let disabled_frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native shadow-off probe bindings"),
            layout: frame_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: shadow_map.section_uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: frame_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&unshadowed_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&shadow_map.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(ibl.specular_view()),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(ibl.diffuse_view()),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(ibl.brdf_lut_view()),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::Sampler(ibl.sampler()),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: shadow_map.sampling_uniform.as_entire_binding(),
                },
            ],
        });
        let width = size.width.max(1);
        let height = size.height.max(1);
        let unpadded = width * BYTES_PER_PIXEL;
        let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = unpadded.div_ceil(alignment) * alignment;
        let buffer_size = u64::from(padded_bytes_per_row) * u64::from(height);
        let readback = |label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: buffer_size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        };
        Self {
            _unshadowed_texture: unshadowed_texture,
            unshadowed_layer_views,
            disabled_frame_bind_group,
            shadowed_readback: readback("Deep Engine native shadow-on HDR readback"),
            unshadowed_readback: readback("Deep Engine native shadow-off HDR readback"),
            width,
            height,
            padded_bytes_per_row,
        }
    }

    pub fn disabled_frame_bind_group(&self) -> &wgpu::BindGroup {
        &self.disabled_frame_bind_group
    }

    pub fn clear_unshadowed_map(&self, encoder: &mut wgpu::CommandEncoder) {
        for layer_view in &self.unshadowed_layer_views {
            let pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Deep Engine native all-lit shadow probe clear"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: layer_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            drop(pass);
        }
    }

    pub fn copy_shadowed(&self, encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture) {
        self.copy(encoder, texture, &self.shadowed_readback);
    }

    pub fn copy_unshadowed(&self, encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture) {
        self.copy(encoder, texture, &self.unshadowed_readback);
    }

    pub fn finish(
        &self,
        device: &wgpu::Device,
        version: ShadowVersion,
    ) -> Result<ShadowProbeMetrics, String> {
        let shadowed = map_buffer(device, &self.shadowed_readback, "shadow-on")?;
        let unshadowed = map_buffer(device, &self.unshadowed_readback, "shadow-off")?;
        let mut changed_pixels = 0;
        let mut shadowed_luminance = 0.0;
        let mut unshadowed_luminance = 0.0;
        let mut shadow_effect_hash = 0xcbf29ce484222325_u64;
        for row in 0..self.height as usize {
            let row_start = row * self.padded_bytes_per_row as usize;
            for column in 0..self.width as usize {
                let offset = row_start + column * BYTES_PER_PIXEL as usize;
                let on = &shadowed[offset..offset + BYTES_PER_PIXEL as usize];
                let off = &unshadowed[offset..offset + BYTES_PER_PIXEL as usize];
                if on != off {
                    changed_pixels += 1;
                }
                for value in on.iter().zip(off).map(|(on, off)| on ^ off) {
                    shadow_effect_hash ^= u64::from(value);
                    shadow_effect_hash = shadow_effect_hash.wrapping_mul(0x100000001b3);
                }
                shadowed_luminance += pixel_luminance(on);
                unshadowed_luminance += pixel_luminance(off);
            }
        }
        drop(shadowed);
        drop(unshadowed);
        self.shadowed_readback.unmap();
        self.unshadowed_readback.unmap();
        if changed_pixels < 4 {
            return Err(format!(
                "shadow probe found only {changed_pixels} changed HDR pixels between shadow on/off"
            ));
        }
        if !shadowed_luminance.is_finite() || !unshadowed_luminance.is_finite() {
            return Err("shadow probe produced non-finite HDR luminance".into());
        }
        if unshadowed_luminance - shadowed_luminance <= 0.01 {
            return Err(format!(
                "shadow probe did not darken the scene: on={shadowed_luminance:.6} off={unshadowed_luminance:.6}"
            ));
        }
        Ok(ShadowProbeMetrics {
            changed_pixels,
            shadowed_luminance,
            unshadowed_luminance,
            shadow_effect_hash,
            version,
        })
    }

    fn copy(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture,
        buffer: &wgpu::Buffer,
    ) {
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_bytes_per_row),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
    }
}

fn map_buffer(
    device: &wgpu::Device,
    buffer: &wgpu::Buffer,
    label: &str,
) -> Result<wgpu::BufferView, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| format!("{label} shadow probe device poll failed: {error}"))?;
    receiver
        .recv()
        .map_err(|error| format!("{label} shadow probe callback failed: {error}"))?
        .map_err(|error| format!("{label} shadow probe map failed: {error}"))?;
    buffer
        .get_mapped_range(..)
        .map_err(|error| format!("{label} shadow probe mapped range failed: {error}"))
}

fn pixel_luminance(pixel: &[u8]) -> f64 {
    let channel = |offset| half_to_f32(u16::from_le_bytes([pixel[offset], pixel[offset + 1]]));
    f64::from(channel(0)) * 0.2126 + f64::from(channel(2)) * 0.7152 + f64::from(channel(4)) * 0.0722
}
