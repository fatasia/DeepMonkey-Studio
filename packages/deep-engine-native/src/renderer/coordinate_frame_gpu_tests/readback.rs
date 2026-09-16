use super::*;

pub(super) fn capture(renderer: &Renderer) -> Vec<u8> {
    let row_bytes = SIZE.width * 8; // 640 * RGBA16F is already 256-byte aligned.
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("coordinate frame HDR readback"),
        size: u64::from(row_bytes * SIZE.height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = renderer.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: renderer.forward_targets.resolved_texture(),
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(SIZE.height),
            },
        },
        wgpu::Extent3d {
            width: SIZE.width,
            height: SIZE.height,
            depth_or_array_layers: 1,
        },
    );
    renderer.queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    renderer
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = buffer.get_mapped_range(..).unwrap().to_vec();
    buffer.unmap();
    bytes
}

fn luminance(pixel: &[u8]) -> f64 {
    let channel = |i| {
        let v = half_to_f32(u16::from_le_bytes([pixel[i], pixel[i + 1]]));
        assert!(v.is_finite());
        f64::from(v)
    };
    channel(0) * 0.2126 + channel(2) * 0.7152 + channel(4) * 0.0722
}

pub(super) fn assert_visible(bytes: &[u8]) {
    assert!(
        bytes
            .chunks_exact(8)
            .filter(|pixel| *pixel != &bytes[..8])
            .count()
            > 64,
        "HDR scene is flat or empty"
    );
}

pub(super) fn compare(first: &[u8], second: &[u8]) -> (f64, f64) {
    assert_eq!(first.len(), second.len());
    let mut changed = 0;
    let mut a = 0.0;
    let mut b = 0.0;
    for (left, right) in first.chunks_exact(8).zip(second.chunks_exact(8)) {
        if left != right {
            changed += 1;
        }
        a += luminance(left);
        b += luminance(right);
    }
    assert!(a > 0.0);
    (changed as f64 / (first.len() / 8) as f64, (a - b).abs() / a)
}
