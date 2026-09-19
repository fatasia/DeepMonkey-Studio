use super::*;

pub(super) fn verify(window: Arc<Window>, proxy: EventLoopProxy<GpuEvent>) {
    let content = lit_content_modify(
        [0.0; 3],
        Some(
            json!({"direction":[0,1,0],"radiance":[0,0,0],"exposure":1.05,"shadows":false,
        "localLights":[{"kind":"point","position":[0,0,0],"direction":[0,-1,0],"radiance":[16,16,16],"range":12,"decay":2,"innerCos":1,"outerCos":0,"castShadow":true}]}),
        ),
        None,
        None,
        |packet| {
            let template = packet["instances"][0].clone();
            packet["instances"] = Value::Array(
                deep_engine_native::local_shadow::POINT_DIRECTIONS
                    .into_iter()
                    .enumerate()
                    .map(|(i, direction)| {
                        let mut instance = template.clone();
                        instance["id"] = json!(format!("face-{i}"));
                        instance["castShadow"] = json!(true);
                        instance["transform"] = json!([
                            0.5,
                            0,
                            0,
                            0,
                            0,
                            0.5,
                            0,
                            0,
                            0,
                            0,
                            0.5,
                            0,
                            direction[0] * 2.0,
                            direction[1] * 2.0,
                            direction[2] * 2.0,
                            1
                        ]);
                        instance
                    })
                    .collect(),
            );
        },
    );
    let features = RendererFeatures {
        bloom: entry_bloom(&content),
        fog: FogSettings::DISABLED,
        shadow_probe: false,
        ibl_probe: false,
        telemetry: false,
    };
    let mut renderer = pollster::block_on(Renderer::new_candidate(
        window,
        proxy,
        180,
        &content,
        content.initial_view(),
        features,
    ))
    .unwrap();
    renderer.activate_surface();
    present(&mut renderer);
    let texture = &renderer.shadow_map._texture;
    let stride = texture.width() * 4;
    let layer_bytes = u64::from(stride) * u64::from(texture.height());
    let center = (texture.height() / 2 * stride + texture.width() / 2 * 4) as usize;
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("point six faces"),
        size: layer_bytes * 6,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = renderer.device.create_command_encoder(&Default::default());
    for face in 0..6u32 {
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: 0,
                    y: 0,
                    z: 4 + face,
                },
                aspect: wgpu::TextureAspect::DepthOnly,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: u64::from(face) * layer_bytes,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(texture.height()),
                },
            },
            wgpu::Extent3d {
                width: texture.width(),
                height: texture.height(),
                depth_or_array_layers: 1,
            },
        );
    }
    renderer.queue.submit([encoder.finish()]);
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = send.send(result);
    });
    renderer
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    receive.recv().unwrap().unwrap();
    let bytes = buffer.get_mapped_range(..).unwrap();
    let depths: Vec<f32> = (0..6)
        .map(|face| {
            let offset = face * layer_bytes as usize + center;
            f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
        })
        .collect();
    drop(bytes);
    buffer.unmap();
    assert!(
        depths.iter().all(|depth| *depth > 0.0 && *depth < 1.0),
        "all six faces must draw center caster: {depths:?}"
    );
    println!("point shadow six-face depth readback: {depths:?}");
}
