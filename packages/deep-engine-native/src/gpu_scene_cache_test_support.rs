//! Shared real-GPU test support for the scene cache unit modules. Everything here
//! requires a physical adapter, so callers must gate themselves behind `#[ignore]`.

use std::sync::{Arc, Mutex, mpsc};

use deep_engine_native::{
    contract::{
        RenderPacket, default_alpha_fixture_path, default_textured_fixture_path, load_and_validate,
    },
    mesh_abi::PACKED_INSTANCE_BYTES,
    pbr_texture::{PreparedPbrResources, prepare_pbr_resources},
    scene::{PreparedScene, prepare_scene},
};

use crate::{
    gpu_scene::GpuScene,
    gpu_scene_cache::{GpuSceneCache, GpuSceneCandidate},
    player_shader_plan::scene_content_key,
};

pub(crate) fn textured_packet() -> RenderPacket {
    load_and_validate(default_textured_fixture_path())
        .unwrap()
        .0
}

pub(crate) fn alpha_packet() -> RenderPacket {
    load_and_validate(default_alpha_fixture_path()).unwrap().0
}

pub(crate) fn prepare(packet: &RenderPacket) -> (PreparedScene, PreparedPbrResources) {
    (
        prepare_scene(packet).unwrap(),
        prepare_pbr_resources(packet).unwrap(),
    )
}

pub(crate) fn stage(
    cache: &GpuSceneCache,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    layout: &wgpu::BindGroupLayout,
    packet: &RenderPacket,
) -> GpuSceneCandidate {
    let (scene, pbr) = prepare(packet);
    cache
        .stage(
            device,
            queue,
            layout,
            packet,
            scene_content_key(packet),
            &scene,
            &pbr,
        )
        .unwrap()
}

pub(crate) fn read_instances(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    scene: &GpuScene,
    count: usize,
) -> Vec<u8> {
    let bytes = u64::try_from(count.max(1)).unwrap() * PACKED_INSTANCE_BYTES;
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("native scene cache instance readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(&scene.instance_buffer, 0, &output, 0, bytes);
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    output.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let result = output.get_mapped_range(..).unwrap().to_vec();
    output.unmap();
    result
}

pub(crate) fn push_scopes(device: &wgpu::Device) -> [wgpu::ErrorScopeGuard; 3] {
    [
        device.push_error_scope(wgpu::ErrorFilter::Validation),
        device.push_error_scope(wgpu::ErrorFilter::OutOfMemory),
        device.push_error_scope(wgpu::ErrorFilter::Internal),
    ]
}

pub(crate) async fn clean_scopes(scopes: [wgpu::ErrorScopeGuard; 3], label: &str) {
    let [validation, memory, internal] = scopes;
    for error in [
        internal.pop().await,
        memory.pop().await,
        validation.pop().await,
    ] {
        assert!(error.is_none(), "{label} GPU error: {error:?}");
    }
}

/// Real adapter + device shared by every ignored scene-cache test. Fails when only a
/// software adapter is available so CI never silently exercises the fallback renderer.
pub(crate) async fn high_performance_device() -> (wgpu::Device, wgpu::Queue) {
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
    assert_ne!(info.device_type, wgpu::DeviceType::Cpu, "software adapter");
    println!("native scene cache adapter: {info:?}");
    adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .unwrap()
}

/// Captures uncaptured GPU errors so a test can assert none escaped its scopes.
pub(crate) fn capture_uncaptured_errors(device: &wgpu::Device) -> Arc<Mutex<Vec<String>>> {
    let errors = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&errors);
    device.on_uncaptured_error(Arc::new(move |error| {
        sink.lock().unwrap().push(error.to_string());
    }));
    errors
}

pub(crate) fn assert_no_uncaptured_errors(errors: &Mutex<Vec<String>>) {
    assert!(
        errors.lock().unwrap().is_empty(),
        "uncaptured GPU errors: {:?}",
        errors.lock().unwrap()
    );
}
