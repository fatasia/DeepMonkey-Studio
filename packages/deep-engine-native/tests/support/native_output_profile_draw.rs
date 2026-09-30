use super::output_pass;
use deep_engine_native::{
    half_decode::half_to_f32,
    mesh_abi::{FORWARD_DEPTH_FORMAT, FORWARD_SAMPLE_COUNT, frame_uniform},
    output_color_profile::OutputColorProfile,
};
use std::sync::mpsc;
use wgpu::util::DeviceExt;

pub(super) fn draw(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    color: [f64; 3],
    profile: OutputColorProfile,
    bloom: bool,
    fog: bool,
    grading: Option<[f32; 12]>,
) -> [f64; 4] {
    let extent = wgpu::Extent3d {
        width: 32,
        height: 1,
        depth_or_array_layers: 1,
    };
    let texture = |label, format, sample_count, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: extent,
            mip_level_count: 1,
            sample_count,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let source = texture(
        "profile HDR source",
        wgpu::TextureFormat::Rgba16Float,
        1,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let source_view = source.create_view(&Default::default());
    let target = texture(
        "profile output",
        wgpu::TextureFormat::Rgba16Float,
        1,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
    );
    let depth = texture(
        "profile zero density fog",
        FORWARD_DEPTH_FORMAT,
        FORWARD_SAMPLE_COUNT,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let depth_view = depth.create_view(&Default::default());
    let frame = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("profile frame"),
        contents: bytemuck::cast_slice(&frame_uniform(1.0, 0.0)),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let output = output_pass::OutputPass::new_with_profile(
        device,
        wgpu::TextureFormat::Rgba16Float,
        &source_view,
        bloom.then_some((&source_view, 0.0)),
        fog.then_some((&depth_view, &frame)),
        grading,
        profile,
    );
    let read = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("profile readback"),
        size: 256,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &source_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: color[0],
                        g: color[1],
                        b: color[2],
                        a: 0.5,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            ..Default::default()
        });
    }
    {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
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
    }
    output.draw(&mut encoder, &target.create_view(&Default::default()));
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &read,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(1),
            },
        },
        extent,
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    read.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap()
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = read.get_mapped_range(..).unwrap();
    let value = std::array::from_fn(|i| {
        f64::from(half_to_f32(u16::from_le_bytes([
            bytes[i * 2],
            bytes[i * 2 + 1],
        ])))
    });
    drop(bytes);
    read.unmap();
    assert!(pollster::block_on(scope.pop()).is_none());
    value
}
