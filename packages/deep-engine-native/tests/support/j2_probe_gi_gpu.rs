use wgpu::util::DeviceExt;

#[allow(dead_code)]
#[path = "lod_draw_readback.rs"]
mod readback;

pub fn gpu() -> (wgpu::Device, wgpu::Queue, String) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN | wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .expect("real GPU adapter");
    let info = adapter.get_info();
    assert!(matches!(
        info.device_type,
        wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
    ));
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    (device, queue, format!("{info:?}"))
}

pub fn sample(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    code: &str,
    records: &[u8],
    receiver: &[f32; 8],
) -> [f32; 3] {
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("actual production GI functions"),
        source: wgpu::ShaderSource::Wgsl(code.into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: None,
        module: &module,
        entry_point: Some("probeMain"),
        compilation_options: Default::default(),
        cache: None,
    });
    let buffer = |bytes: &[u8], usage| {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("J2 probe fixture"),
            contents: bytes,
            usage,
        })
    };
    let storage = buffer(records, wgpu::BufferUsages::STORAGE);
    let input = buffer(bytemuck::cast_slice(receiver), wgpu::BufferUsages::STORAGE);
    let output = buffer(
        &[0u8; 16],
        wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    );
    let staging = readback::staging(device, 16);
    let sampling = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 11,
            resource: storage.as_entire_binding(),
        }],
    });
    let io = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(1),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: input.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: output.as_entire_binding(),
            },
        ],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &sampling, &[]);
        pass.set_bind_group(1, &io, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &staging, 0, 16);
    queue.submit([encoder.finish()]);
    let bytes = readback::mapped_bytes(device, &staging);
    assert!(
        pollster::block_on(scope.pop()).is_none(),
        "GPU validation error"
    );
    std::array::from_fn(|index| {
        f32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap())
    })
}
