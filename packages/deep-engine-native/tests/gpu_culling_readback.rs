use std::sync::mpsc;

use bytemuck::cast_slice;
use deep_engine_native::{culling_contract::sphere_visible, scene::PackedInstance};
use wgpu::util::DeviceExt;

#[test]
#[ignore = "requires a real GPU; run this test explicitly with --ignored"]
fn affine_culling_shader_matches_visible_geometry_on_real_gpu() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("GPU device");
        let n = std::f32::consts::FRAC_1_SQRT_2;
        let mut shear = identity();
        shear[1] = 1.0;
        shear[3] = -1.5 * n;
        shear[7] = -1.5 * n;
        let mut outside = shear;
        outside[3] = -1.7 * n;
        outside[7] = -1.7 * n;
        check(&device, &queue, [[n, n, 0.0, 0.0]; 6], &[shear, outside]);

        let mut mirror = identity();
        mirror[0] = -10.0;
        mirror[5] = 0.25;
        mirror[7] = -0.25;
        outside = mirror;
        outside[7] = -0.5;
        check(
            &device,
            &queue,
            [[0.0, 1.0, 0.0, 0.0]; 6],
            &[mirror, outside],
        );
        println!(
            "Affine culling GPU readback passed: {:?}",
            adapter.get_info()
        );
    });
}

fn identity() -> PackedInstance {
    let mut instance = [0.0; 36];
    instance[0] = 1.0;
    instance[5] = 1.0;
    instance[10] = 1.0;
    instance
}

fn check(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    planes: [[f32; 4]; 6],
    instances: &[PackedInstance; 2],
) {
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("production affine culling shader"),
        source: wgpu::ShaderSource::Wgsl(
            include_str!("../assets/shaders/native_gpu_culling_v1.wgsl").into(),
        ),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: None,
        module: &shader,
        entry_point: Some("cull_instances"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bound = [0.0_f32, 0.0, 0.0, 1.0];
    assert!(sphere_visible(&planes, &instances[0], bound));
    assert!(!sphere_visible(&planes, &instances[1], bound));
    let storage = wgpu::BufferUsages::STORAGE;
    let make = |label: &str, contents: &[u8], usage| {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents,
            usage,
        })
    };
    let source = make("source", cast_slice(instances), storage);
    let bounds = make("bounds", cast_slice(&[bound; 2]), storage);
    let metadata = make(
        "metadata",
        cast_slice(&[[0_u32, 3, 0, 0], [1, 3, 1, 0]]),
        storage,
    );
    let mut uniform = cast_slice(&planes).to_vec();
    uniform.extend_from_slice(cast_slice(&[2_u32, 1, 0, 0]));
    let params = make("frustum", &uniform, wgpu::BufferUsages::UNIFORM);
    let visible = make("visible", &[0; 288], storage | wgpu::BufferUsages::COPY_SRC);
    let indirect = make(
        "indirect",
        cast_slice(&[[3_u32, 0, 0, 0, 0]; 2]),
        storage | wgpu::BufferUsages::COPY_SRC,
    );
    let buffers = [&source, &bounds, &metadata, &params, &visible, &indirect];
    let entries: Vec<_> = buffers
        .iter()
        .enumerate()
        .map(|(binding, buffer)| wgpu::BindGroupEntry {
            binding: binding as u32,
            resource: buffer.as_entire_binding(),
        })
        .collect();
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &entries,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 328,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&indirect, 0, &readback, 0, 40);
    encoder.copy_buffer_to_buffer(&visible, 0, &readback, 40, 288);
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap();
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = readback.get_mapped_range(..).unwrap();
    assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 0);
    assert_eq!(&bytes[40..184], cast_slice::<f32, u8>(&instances[0]));
    drop(bytes);
    readback.unmap();
    assert!(pollster::block_on(scope.pop()).is_none());
}
