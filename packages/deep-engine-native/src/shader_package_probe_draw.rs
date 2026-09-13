use std::sync::mpsc;

use deep_engine_native::shader_package::ExecutableShaderPass;

use crate::shader_package_probe_resources::ProbeResources;

const WIDTH: u32 = 4;
const HEIGHT: u32 = 4;
const ROW_BYTES: u32 = 256;

pub(crate) fn draw_and_readback(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    forward: &ExecutableShaderPass,
    shadow: &ExecutableShaderPass,
    resources: &ProbeResources,
) -> Result<([f32; 4], f32), String> {
    if !forward.resolve_required || shadow.resolve_required {
        return Err("package resolve contract differs from the render probe".into());
    }
    let size = wgpu::Extent3d {
        width: WIDTH,
        height: HEIGHT,
        depth_or_array_layers: 1,
    };
    let color_msaa = texture(
        device,
        "package probe MSAA HDR",
        size,
        4,
        wgpu::TextureFormat::Rgba16Float,
        wgpu::TextureUsages::RENDER_ATTACHMENT,
    );
    let color = texture(
        device,
        "package probe resolved HDR",
        size,
        1,
        wgpu::TextureFormat::Rgba16Float,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
    );
    let forward_depth = texture(
        device,
        "package probe forward depth",
        size,
        4,
        wgpu::TextureFormat::Depth24Plus,
        wgpu::TextureUsages::RENDER_ATTACHMENT,
    );
    let shadow_depth = texture(
        device,
        "package probe shadow depth",
        size,
        1,
        wgpu::TextureFormat::Depth32Float,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
    );
    let color_readback = readback_buffer(device, "package probe HDR readback", ROW_BYTES * HEIGHT);
    let depth_readback =
        readback_buffer(device, "package probe depth readback", ROW_BYTES * HEIGHT);

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Deep Shader Package GPU probe encoder"),
    });
    encode_forward(
        &mut encoder,
        forward,
        &color_msaa,
        &color,
        &forward_depth,
        resources,
    );
    encode_shadow(&mut encoder, shadow, &shadow_depth, resources);
    copy_texture(
        &mut encoder,
        &color,
        &color_readback,
        wgpu::TextureAspect::All,
    );
    copy_texture(
        &mut encoder,
        &shadow_depth,
        &depth_readback,
        wgpu::TextureAspect::DepthOnly,
    );
    queue.submit([encoder.finish()]);
    let color_bytes = map_buffer(device, &color_readback, "HDR")?;
    let depth_bytes = map_buffer(device, &depth_readback, "depth")?;
    let color_pixel = [
        half_to_f32(u16::from_le_bytes([color_bytes[0], color_bytes[1]])),
        half_to_f32(u16::from_le_bytes([color_bytes[2], color_bytes[3]])),
        half_to_f32(u16::from_le_bytes([color_bytes[4], color_bytes[5]])),
        half_to_f32(u16::from_le_bytes([color_bytes[6], color_bytes[7]])),
    ];
    let depth_pixel = f32::from_le_bytes(depth_bytes[0..4].try_into().expect("depth pixel"));
    drop(color_bytes);
    drop(depth_bytes);
    color_readback.unmap();
    depth_readback.unmap();
    Ok((color_pixel, depth_pixel))
}

fn encode_forward(
    encoder: &mut wgpu::CommandEncoder,
    pass: &ExecutableShaderPass,
    msaa: &wgpu::Texture,
    resolved: &wgpu::Texture,
    depth: &wgpu::Texture,
    resources: &ProbeResources,
) {
    let msaa_view = msaa.create_view(&Default::default());
    let resolved_view = resolved.create_view(&Default::default());
    let depth_view = depth.create_view(&Default::default());
    let color_attachments = [Some(wgpu::RenderPassColorAttachment {
        view: &msaa_view,
        depth_slice: None,
        resolve_target: Some(&resolved_view),
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            store: wgpu::StoreOp::Discard,
        },
    })];
    let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Deep package forward probe"),
        color_attachments: &color_attachments,
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: &depth_view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(1.0),
                store: wgpu::StoreOp::Discard,
            }),
            stencil_ops: None,
        }),
        ..Default::default()
    });
    render.set_pipeline(&pass.pipeline);
    render.set_bind_group(0, &resources.forward_bind_group, &[]);
    render.set_vertex_buffer(0, resources.geometry.slice(..));
    render.set_vertex_buffer(1, resources.instance.slice(..));
    render.draw(0..3, 0..1);
}

fn encode_shadow(
    encoder: &mut wgpu::CommandEncoder,
    pass: &ExecutableShaderPass,
    depth: &wgpu::Texture,
    resources: &ProbeResources,
) {
    let depth_view = depth.create_view(&Default::default());
    let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Deep package shadow probe"),
        color_attachments: &[],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: &depth_view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(1.0),
                store: wgpu::StoreOp::Store,
            }),
            stencil_ops: None,
        }),
        ..Default::default()
    });
    render.set_pipeline(&pass.pipeline);
    render.set_bind_group(0, &resources.shadow_bind_group, &[]);
    render.set_vertex_buffer(0, resources.geometry.slice(..));
    render.set_vertex_buffer(1, resources.instance.slice(..));
    render.draw(0..3, 0..1);
}

fn texture(
    device: &wgpu::Device,
    label: &str,
    size: wgpu::Extent3d,
    sample_count: u32,
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size,
        mip_level_count: 1,
        sample_count,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn readback_buffer(device: &wgpu::Device, label: &str, size: u32) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: u64::from(size),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    })
}

fn copy_texture(
    encoder: &mut wgpu::CommandEncoder,
    texture: &wgpu::Texture,
    buffer: &wgpu::Buffer,
    aspect: wgpu::TextureAspect,
) {
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect,
        },
        wgpu::TexelCopyBufferInfo {
            buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(ROW_BYTES),
                rows_per_image: Some(HEIGHT),
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );
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
        .map_err(|error| format!("{label} readback poll failed: {error}"))?;
    receiver
        .recv()
        .map_err(|error| format!("{label} readback callback failed: {error}"))?
        .map_err(|error| format!("{label} readback map failed: {error}"))?;
    buffer
        .get_mapped_range(..)
        .map_err(|error| format!("{label} mapped range failed: {error}"))
}

fn half_to_f32(value: u16) -> f32 {
    let sign = if value & 0x8000 == 0 { 1.0 } else { -1.0 };
    let exponent = i32::from((value >> 10) & 0x1f);
    let mantissa = u32::from(value & 0x03ff);
    match exponent {
        0 => sign * (mantissa as f32 / 1_024.0) * 2.0_f32.powi(-14),
        31 if mantissa == 0 => sign * f32::INFINITY,
        31 => f32::NAN,
        _ => sign * (1.0 + mantissa as f32 / 1_024.0) * 2.0_f32.powi(exponent - 15),
    }
}
