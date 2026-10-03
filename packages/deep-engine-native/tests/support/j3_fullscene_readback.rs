use crate::{forward_targets::ForwardTargets, shadow_map::ShadowMap};
#[path = "j3_geometry_depth_readback.rs"]
mod depth;
#[path = "../../src/output_pass.rs"]
mod output_pass;

pub struct Readback {
    pub depth: wgpu::Buffer,
    pub normals: wgpu::Buffer,
    pub display: wgpu::Buffer,
    pub shadow_uniform: wgpu::Buffer,
}

/// Encodes production OutputPass directly after the actual scene HDR draw.
pub fn encode(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    shadows: &ShadowMap,
    width: u32,
    height: u32,
) -> Readback {
    let depth = depth::encode(device, encoder, &targets.depth_view, width, height);
    let normals = crate::lod_draw_readback::staging(device, u64::from(width * height * 4));
    let normal = targets
        .resolved_normal_texture()
        .expect("actual industrial normal attachment");
    encoder.copy_texture_to_buffer(
        normal.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &normals,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
        },
        normal.size(),
    );
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("J3 industrial product output"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    output_pass::OutputPass::new(
        device,
        wgpu::TextureFormat::Rgba8Unorm,
        &targets.hdr_view,
        None,
        None,
        None,
    )
    .draw(encoder, &target.create_view(&Default::default()));
    let display = crate::lod_draw_readback::staging(device, u64::from(width * height * 4));
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &display,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
        },
        target.size(),
    );
    let shadow_uniform = crate::lod_draw_readback::staging(
        device,
        deep_engine_native::cascaded_shadow::CASCADED_SHADOW_UNIFORM_BYTES,
    );
    encoder.copy_buffer_to_buffer(
        &shadows.sampling_uniform,
        0,
        &shadow_uniform,
        0,
        deep_engine_native::cascaded_shadow::CASCADED_SHADOW_UNIFORM_BYTES,
    );
    Readback {
        depth,
        normals,
        display,
        shadow_uniform,
    }
}
