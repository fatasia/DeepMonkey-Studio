use std::sync::{Arc, Mutex, mpsc};

use deep_engine_native::{
    contract::{RenderPacket, default_textured_fixture_path, load_and_validate},
    mesh_abi::PACKED_INSTANCE_BYTES,
    pbr_texture::{PreparedPbrResources, prepare_pbr_resources},
    scene::{PreparedScene, prepare_scene},
};

use crate::{
    gpu_scene::GpuScene, gpu_scene_cache::GpuSceneCache, gpu_textures::create_material_layout,
    player_shader_plan::scene_content_key,
};

fn packet() -> RenderPacket {
    load_and_validate(default_textured_fixture_path())
        .unwrap()
        .0
}

fn prepare(packet: &RenderPacket) -> (PreparedScene, PreparedPbrResources) {
    (
        prepare_scene(packet).unwrap(),
        prepare_pbr_resources(packet).unwrap(),
    )
}

fn stage(
    cache: &GpuSceneCache,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    layout: &wgpu::BindGroupLayout,
    packet: &RenderPacket,
) -> crate::gpu_scene_cache::GpuSceneCandidate {
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

fn read_instances(
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

async fn clean_scope(scopes: [wgpu::ErrorScopeGuard; 3]) {
    let [validation, memory, internal] = scopes;
    for error in [
        internal.pop().await,
        memory.pop().await,
        validation.pop().await,
    ] {
        assert!(error.is_none(), "native cache GPU error: {error:?}");
    }
}

fn push_scopes(device: &wgpu::Device) -> [wgpu::ErrorScopeGuard; 3] {
    [
        device.push_error_scope(wgpu::ErrorFilter::Validation),
        device.push_error_scope(wgpu::ErrorFilter::OutOfMemory),
        device.push_error_scope(wgpu::ErrorFilter::Internal),
    ]
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_packet_cache_reuses_replaces_rolls_back_and_releases() {
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
        assert_ne!(info.device_type, wgpu::DeviceType::Cpu, "software adapter");
        println!("native packet cache adapter: {info:?}");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let uncaptured = Arc::new(Mutex::new(Vec::new()));
        let errors = Arc::clone(&uncaptured);
        device.on_uncaptured_error(Arc::new(move |error| {
            errors.lock().unwrap().push(error.to_string());
        }));
        let layout = create_material_layout(&device);
        let mut cache = GpuSceneCache::new(&device, 41);
        let source = packet();

        let scopes = push_scopes(&device);
        let first = stage(&cache, &device, &queue, &layout, &source);
        let first_metrics = first.metrics();
        assert_eq!(first_metrics.geometry_uploads, source.geometries.len());
        assert_eq!(first_metrics.texture_uploads, source.textures.len());
        assert_eq!(first_metrics.material_uploads, source.materials.len());
        assert_eq!(first_metrics.instance_buffer_uploads, 1);
        clean_scope(scopes).await;
        let first = cache.commit(first).unwrap();
        let first_bytes = read_instances(&device, &queue, &first, source.instances.len());

        let same = stage(&cache, &device, &queue, &layout, &source);
        let same_metrics = same.metrics();
        assert_eq!(same_metrics.geometry_reuses, source.geometries.len());
        assert_eq!(same_metrics.texture_reuses, source.textures.len());
        assert_eq!(same_metrics.material_reuses, source.materials.len());
        assert_eq!(same_metrics.instance_buffer_reuses, 1);
        let same = cache.commit(same).unwrap();

        let mut moved = packet();
        moved.instances[0].transform[12] += 0.4;
        let scopes = push_scopes(&device);
        let moved_candidate = stage(&cache, &device, &queue, &layout, &moved);
        let moved_metrics = moved_candidate.metrics();
        assert_eq!(moved_metrics.geometry_reuses, moved.geometries.len());
        assert_eq!(moved_metrics.texture_reuses, moved.textures.len());
        assert_eq!(moved_metrics.material_reuses, moved.materials.len());
        assert_eq!(moved_metrics.instance_uploaded_bytes, PACKED_INSTANCE_BYTES);
        assert_eq!(moved_metrics.instance_copied_bytes, PACKED_INSTANCE_BYTES);
        clean_scope(scopes).await;
        let moved_scene = cache.commit(moved_candidate).unwrap();
        let moved_bytes = read_instances(&device, &queue, &moved_scene, moved.instances.len());
        assert_ne!(
            &first_bytes[..PACKED_INSTANCE_BYTES as usize],
            &moved_bytes[..PACKED_INSTANCE_BYTES as usize]
        );
        assert_eq!(
            &first_bytes[PACKED_INSTANCE_BYTES as usize..],
            &moved_bytes[PACKED_INSTANCE_BYTES as usize..]
        );

        let mut illegal = packet();
        illegal.geometries[0].vertices[0] += 0.5;
        let error = match cache.stage(
            &device,
            &queue,
            &layout,
            &illegal,
            scene_content_key(&illegal),
            &prepare_scene(&illegal).unwrap(),
            &prepare_pbr_resources(&illegal).unwrap(),
        ) {
            Ok(_) => panic!("reused revision was accepted"),
            Err(error) => error,
        };
        assert!(error.contains("reused for different content"), "{error}");
        assert_eq!(
            first_bytes,
            read_instances(&device, &queue, &first, source.instances.len())
        );

        let mut material = packet();
        material.materials[0]
            .base_color_texture
            .as_mut()
            .unwrap()
            .rotation = Some(0.75);
        let invalid_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("intentionally invalid material cache layout"),
            entries: &[],
        });
        let invalid_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let rejected = stage(&cache, &device, &queue, &invalid_layout, &material);
        assert!(invalid_scope.pop().await.is_some());
        drop(rejected);
        let retry = stage(&cache, &device, &queue, &layout, &material);
        assert_eq!(
            retry.metrics().material_uploads,
            1,
            "failed candidate leaked into cache"
        );
        let latest = cache.commit(retry).unwrap();

        drop(first);
        drop(same);
        drop(moved_scene);
        assert_eq!(cache.live_resources().geometries, source.geometries.len());
        assert_eq!(cache.live_resources().textures, source.textures.len());
        assert_eq!(cache.live_resources().materials, source.materials.len());
        assert_eq!(cache.live_resources().instance_buffers, 1);
        drop(latest);
        assert_eq!(cache.live_resources(), Default::default());

        let stale = stage(&cache, &device, &queue, &layout, &source);
        cache.reset(&device, 42);
        let error = match cache.commit(stale) {
            Ok(_) => panic!("stale cache candidate was accepted"),
            Err(error) => error,
        };
        assert!(error.contains("stale"), "{error}");
        assert_eq!(cache.epoch(), 42);
        assert!(
            uncaptured.lock().unwrap().is_empty(),
            "uncaptured GPU errors: {:?}",
            uncaptured.lock().unwrap()
        );
        println!(
            "native packet cache: first={first_metrics:?} same={same_metrics:?} moved={moved_metrics:?}; release=0; epoch=42"
        );
    });
}
