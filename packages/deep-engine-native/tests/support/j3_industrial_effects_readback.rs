use crate::{bloom_pass::BloomPass, forward_targets::ForwardTargets};
use deep_engine_native::{bloom::BloomSettings, mesh_abi::FrameUniform};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;
#[path = "j3_geometry_depth_readback.rs"]
mod depth;
#[path = "../../src/output_pass.rs"]
mod output_pass;
pub struct Readback {
    pub depth: wgpu::Buffer,
    pub display: wgpu::Buffer,
    pub blurred: Option<wgpu::Buffer>,
}
pub fn encode(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    frame: &FrameUniform,
    profile: &str,
    size: PhysicalSize<u32>,
) -> Readback {
    let volume = profile.contains("volume");
    let bloom = profile.contains("bloom").then(|| {
        BloomPass::new(device, &targets.hdr_view, size, BloomSettings::default())
            .unwrap()
            .unwrap()
    });
    let blurred = bloom.as_ref().map(|pass| {
        pass.encode(encoder);
        let texture = pass.output_texture();
        let buffer = crate::lod_draw_readback::staging(
            device,
            u64::from(texture.width() * texture.height() * 8),
        );
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(texture.width() * 8),
                    rows_per_image: Some(texture.height()),
                },
            },
            texture.size(),
        );
        buffer
    });
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("actual industrial effects frame"),
        contents: bytemuck::cast_slice(frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let output = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("actual industrial effects output"),
        size: wgpu::Extent3d {
            width: size.width,
            height: size.height,
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
        bloom
            .as_ref()
            .map(|pass| (pass.output_view(), pass.settings().intensity)),
        volume.then_some((&targets.depth_view, &uniform)),
        None,
    )
    .draw(encoder, &output.create_view(&Default::default()));
    let display =
        crate::lod_draw_readback::staging(device, u64::from(size.width * size.height * 4));
    encoder.copy_texture_to_buffer(
        output.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &display,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(size.width * 4),
                rows_per_image: Some(size.height),
            },
        },
        output.size(),
    );
    Readback {
        depth: depth::encode(
            device,
            encoder,
            &targets.depth_view,
            size.width,
            size.height,
        ),
        display,
        blurred,
    }
}
