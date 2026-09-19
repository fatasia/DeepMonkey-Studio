use super::*;

pub(super) fn verify(window: Arc<Window>, proxy: EventLoopProxy<GpuEvent>) {
    let mut frames = Vec::new();
    for (index, (radiance, direction, shadows, receive)) in [
        ([0.0, 0.0, 0.0], [0.0, 0.6, 0.8], false, true),
        ([4.0, 0.0, 0.0], [0.0, 0.6, 0.8], false, true),
        ([4.0, 0.0, 0.0], [0.0, -0.6, -0.8], false, true),
        ([4.0, 0.0, 0.0], [0.0, 0.6, 0.8], true, true),
        ([4.0, 0.0, 0.0], [0.0, 0.6, 0.8], true, false),
    ]
    .into_iter()
    .enumerate()
    {
        let content = lit_content(
            [0.0; 3],
            Some(
                json!({"direction":direction,"radiance":radiance,"exposure":1.05,"shadows":shadows}),
            ),
            Some(receive),
        );
        assert!(
            content
                .packet()
                .instances
                .iter()
                .all(|instance| instance.receive_shadow == Some(receive))
        );
        let features = RendererFeatures {
            bloom: entry_bloom(&content),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        };
        let mut renderer = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            proxy.clone(),
            60 + index as u64,
            &content,
            content.initial_view(),
            features,
        ))
        .unwrap();
        renderer.activate_surface();
        present(&mut renderer);
        let actual_direction = crate::gpu_resources::shadow_ray_direction(&renderer.frame);
        for i in 0..3 {
            assert!((f64::from(actual_direction[i]) + direction[i]).abs() < 0.00001);
        }
        let pixels = read_pixels(&renderer);
        // 相机改变不能旋转世界方向光；resize 与 CSM 使用同一冻结方向。
        let mut view = content.initial_view();
        view.yaw += 0.3;
        renderer.set_view(view);
        assert_eq!(
            crate::gpu_resources::shadow_ray_direction(&renderer.frame),
            actual_direction
        );
        renderer.resize(PhysicalSize::new(800, 600)).unwrap();
        assert_eq!(
            crate::gpu_resources::shadow_ray_direction(&renderer.frame),
            actual_direction
        );
        frames.push(pixels);
    }
    let differences = |a: usize, b: usize| {
        frames[a]
            .iter()
            .zip(&frames[b])
            .filter(|(a, b)| (**a - **b).abs() > 0.001)
            .count()
    };
    println!(
        "lighting diagnostics lengths={:?} sums={:?} shadow={} bypass={}",
        frames.iter().map(Vec::len).collect::<Vec<_>>(),
        frames
            .iter()
            .map(|f| f.iter().step_by(4).map(|v| f64::from(*v)).sum::<f64>())
            .collect::<Vec<_>>(),
        differences(1, 3),
        differences(1, 4)
    );
    assert!(
        differences(0, 1) > 100,
        "radiance did not change real pixels"
    );
    assert!(
        differences(1, 2) > 100,
        "world light direction did not change real pixels"
    );
    assert!(
        differences(1, 3) > 100,
        "enabled shadow did not change real pixels"
    );
    assert_eq!(frames[1].len(), frames[4].len());
    assert!(
        frames[1] == frames[4],
        "receiveShadow=false bypass mismatch: {} channels",
        differences(1, 4)
    );
    println!(
        "directional light GPU pixels: intensity={} direction={} shadow={}",
        differences(0, 1),
        differences(1, 2),
        differences(1, 3)
    );
}

pub(super) fn read_pixels(renderer: &Renderer) -> Vec<f32> {
    let width = renderer.forward_targets.resolved_texture().width();
    let height = renderer.forward_targets.resolved_texture().height();
    let stride = (width * 8).div_ceil(256) * 256;
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("authored light readback"),
        size: u64::from(stride) * u64::from(height),
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
                bytes_per_row: Some(stride),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    renderer.queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |r| {
        let _ = sender.send(r);
    });
    renderer
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = buffer.get_mapped_range(..).unwrap().to_vec();
    buffer.unmap();
    bytes
        .chunks_exact(stride as usize)
        .flat_map(|row| {
            row[..width as usize * 8].chunks_exact(2).map(|pair| {
                crate::hdr_readback::half_to_f32(u16::from_le_bytes([pair[0], pair[1]]))
            })
        })
        .collect()
}
