use std::sync::{Arc, Mutex, mpsc};

use deep_engine_native::{
    cascaded_shadow::CASCADED_SHADOW_UNIFORM_BYTES,
    contract::{default_textured_fixture_path, load_and_validate},
    scene_bounds::{SceneWorldBounds, prepare_scene_bounds},
};
use winit::dpi::PhysicalSize;

use crate::{
    frame_bindings::create_frame_layouts,
    gpu_resources::{create_shadow_map, frame_data, shadow_camera, shadow_ray_direction},
    shadow_map::ShadowViewSource,
};

fn read_uniform(device: &wgpu::Device, queue: &wgpu::Queue, source: &wgpu::Buffer) -> Vec<u8> {
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scene-fitted CSM uniform readback"),
        size: CASCADED_SHADOW_UNIFORM_BYTES,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(source, 0, &output, 0, CASCADED_SHADOW_UNIFORM_BYTES);
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    output.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = output.get_mapped_range(..).unwrap().to_vec();
    output.unmap();
    bytes
}

#[test]
#[ignore = "requires a real NVIDIA GPU; run explicitly with --ignored"]
fn nvidia_scene_fitted_shadow_update_is_transactional() {
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
        let info = adapter.get_info();
        assert_eq!(info.vendor, 0x10de, "NVIDIA evidence required: {info:?}");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let errors = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&errors);
        device.on_uncaptured_error(Arc::new(move |error| {
            captured.lock().unwrap().push(error.to_string());
        }));
        let mut packet = load_and_validate(default_textured_fixture_path())
            .unwrap()
            .0;
        let size = PhysicalSize::new(256, 256);
        let frame = frame_data(size, 0.0);
        let layouts = create_frame_layouts(&device);
        let bounds = prepare_scene_bounds(&packet).unwrap();
        let mut shadow = create_shadow_map(&device, &layouts.shadow, size, &frame, bounds).unwrap();
        let initial = read_uniform(&device, &queue, &shadow.sampling_uniform);

        let invalid = SceneWorldBounds {
            minimum: [2.0, 0.0, 0.0],
            maximum: [-2.0, 1.0, 1.0],
        };
        assert!(
            shadow
                .stage_scene_update(
                    &frame,
                    shadow_camera(size, &frame),
                    shadow_ray_direction(&frame),
                    Some(invalid)
                )
                .is_err()
        );
        assert_eq!(
            initial,
            read_uniform(&device, &queue, &shadow.sampling_uniform)
        );

        for instance in &mut packet.instances {
            instance.transform[14] += 2.0;
        }
        let moved_bounds = prepare_scene_bounds(&packet).unwrap();
        let candidate = shadow
            .stage_scene_update(
                &frame,
                shadow_camera(size, &frame),
                shadow_ray_direction(&frame),
                moved_bounds,
            )
            .unwrap();
        assert_eq!(candidate.cascade_count(), shadow.cascade_count());
        assert_eq!(
            initial,
            read_uniform(&device, &queue, &shadow.sampling_uniform)
        );
        shadow.publish_scene_update(&queue, candidate);
        let moved = read_uniform(&device, &queue, &shadow.sampling_uniform);
        assert_ne!(initial, moved);
        assert!(errors.lock().unwrap().is_empty());
        println!(
            "native scene-fitted CSM GPU: adapter={info:?} bytes={} rollback=exact publish=changed",
            moved.len()
        );
    });
}
