//! Depth and HDR target setup for the neutral kernel oracle.
use super::*;

pub(super) fn prepare_targets(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    view: PlayerView,
    projection: &[[f32; 4]; 4],
) -> (wgpu::Texture, wgpu::Texture, Vec<f32>) {
    // MSAA 深度纹理(生产格式 4x)+ 斜面光栅化(背景清屏 1)。
    let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("megalights probe msaa depth"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: FORWARD_SAMPLE_COUNT,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth24Plus,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let depth_view = depth_texture.create_view(&Default::default());
    let (plane_pipeline, plane_vertices) =
        plane_depth_pipeline(device, wgpu::TextureFormat::Depth24Plus);
    // 斜面四角(view 系)→ clip,两三角形全覆盖斜面域。
    let clip_of = |view_point: [f64; 3]| -> [f32; 4] {
        let world = view_to_world(view, view_point);
        let mut clip = [0.0f32; 4];
        for row in 0..4 {
            clip[row] = (0..3)
                .map(|col| projection[col][row] * world[col])
                .sum::<f32>()
                + projection[3][row];
        }
        clip
    };
    let corner = |x: f64, y: f64| [x, y, -3.0 - PLANE_SLOPE * x];
    let quad = [
        corner(PLANE_X.0, PLANE_Y.0),
        corner(PLANE_X.1, PLANE_Y.0),
        corner(PLANE_X.0, PLANE_Y.1),
        corner(PLANE_X.0, PLANE_Y.1),
        corner(PLANE_X.1, PLANE_Y.0),
        corner(PLANE_X.1, PLANE_Y.1),
    ];
    let mut quad_words = Vec::with_capacity(96);
    for vertex in quad {
        quad_words.extend_from_slice(&clip_of(vertex));
    }
    queue.write_buffer(&plane_vertices, 0, bytemuck::cast_slice(&quad_words));

    // HDR 合成目标:预填充图案(加性基线;f16 位级编码上传)。
    let hdr = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("megalights probe hdr"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let _hdr_view = hdr.create_view(&Default::default());
    let mut seed_words = Vec::with_capacity(PIXELS * 4);
    for pixel in 0..PIXELS {
        seed_words.extend_from_slice(&[
            0.25 + 0.25 * (pixel % 7) as f32 / 7.0,
            0.125 + 0.125 * (pixel % 5) as f32 / 5.0,
            0.0625 + 0.0625 * (pixel % 3) as f32 / 3.0,
            1.0,
        ]);
    }
    let seed_f16 = encode_f16_words(&seed_words);
    let bytes_per_row = (WIDTH * 8).next_multiple_of(256);
    let mut staging_seed = vec![0u8; bytes_per_row as usize * HEIGHT as usize];
    for py in 0..HEIGHT as usize {
        let row = &seed_f16[py * WIDTH as usize * 8..(py + 1) * WIDTH as usize * 8];
        staging_seed[py * bytes_per_row as usize..py * bytes_per_row as usize + row.len()]
            .copy_from_slice(row);
    }
    let upload = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("megalights probe hdr seed"),
        size: staging_seed.len() as u64,
        usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&upload, 0, &staging_seed);
    {
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo {
                buffer: &upload,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(HEIGHT),
                },
            },
            wgpu::TexelCopyTextureInfo {
                texture: &hdr,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
        );
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("megalights probe plane depth"),
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
            pass.set_pipeline(&plane_pipeline);
            pass.set_vertex_buffer(0, plane_vertices.slice(..));
            pass.draw(0..6, 0..1);
        }
        queue.submit(Some(encoder.finish()));
    }

    (depth_texture, hdr, seed_words)
}
