use crate::{
    forward_targets::ForwardTargets,
    frame_bindings::{create_frame_layouts, create_native_mesh_shader},
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_resources::{create_shadow_map, frame_data_with_camera},
    gpu_scene::GpuScene,
    gpu_textures::create_material_layout,
    pipeline::{MeshPipelines, create_mesh_pipelines},
    player_shader_plan::scene_content_key,
};
use deep_engine_native::{
    contract::RenderPacket, culling_contract::prepare_gpu_culling, fog::FogSettings,
    ibl::disabled_probe_environment, ies_shading::NativeIesShadingResource, mesh_abi::FrameUniform,
    pbr_texture::prepare_pbr_resources, player_view::PlayerView, scene::prepare_scene,
};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;
pub(super) const SIZE: u32 = 32;

pub(super) fn packet() -> RenderPacket {
    let transform = [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ];
    let mut hidden = transform;
    hidden[12] = 20.;
    serde_json::from_value(serde_json::json!({"schema":"deep-engine.render-packet","version":1,
      "geometries":[
        {"id":"surface","revision":1,"vertices":[-2.,-2.,0.,0.,0.,1., 2.,-2.,0.,0.,0.,1.,
          2.,2.,0.,0.,0.,1., -2.,2.,0.,0.,0.,1.],"indices":[0,1,2,0,2,3]},
        {"id":"wall","revision":1,"vertices":[1.,-1.,0.5,-1.,0.,0., 1.,1.,0.5,-1.,0.,0.,
          1.,1.,1.5,-1.,0.,0., 1.,-1.,1.5,-1.,0.,0.],"indices":[0,1,2,0,2,3]}],
      "materials":[{"id":"blue","baseColor":[0.12,0.42,0.78],"metallic":0.65,"roughness":0.3},
        {"id":"wall","baseColor":[0.4,0.2,0.1],"metallic":0.,"roughness":0.8,"doubleSided":true},
        {"id":"glass","baseColor":[0.1,0.1,0.1],"metallic":0.,"roughness":0.8,"alphaMode":"BLEND"}],
      "instances":[{"id":"surface","geometry":"surface","material":"blue","transform":transform},
        {"id":"wall","geometry":"wall","material":"wall","transform":transform},
        {"id":"offscreen-glass","geometry":"surface","material":"glass","transform":hidden}],"textures":[]})).unwrap()
}

pub(super) async fn device() -> (wgpu::Device, wgpu::Queue) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = if std::env::var("DEEP_MEGA_PROBE_BACKEND").as_deref() == Ok("dx12") {
        wgpu::Backends::DX12
    } else {
        wgpu::Backends::VULKAN
    };
    let adapter = wgpu::Instance::new(descriptor)
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .expect("real GPU");
    eprintln!(
        "MegaLights actual material adapter: {:?}",
        adapter.get_info()
    );
    let ray = adapter
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
    eprintln!("MegaLights hardware ray-query supported: {ray}");
    let limits = adapter.limits();
    adapter
        .request_device(&wgpu::DeviceDescriptor {
            required_features: if ray {
                wgpu::Features::EXPERIMENTAL_RAY_QUERY
            } else {
                wgpu::Features::empty()
            },
            experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
            required_limits: wgpu::Limits {
                max_blas_primitive_count: limits.max_blas_primitive_count,
                max_blas_geometry_count: limits.max_blas_geometry_count,
                max_tlas_instance_count: limits.max_tlas_instance_count,
                max_acceleration_structures_per_shader_stage: limits
                    .max_acceleration_structures_per_shader_stage,
                max_buffers_and_acceleration_structures_per_shader_stage: limits
                    .max_buffers_and_acceleration_structures_per_shader_stage,
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .unwrap()
}

pub(super) struct Fixture {
    pub scene: GpuScene,
    pub culling: GpuCulling,
    pub pipelines: MeshPipelines,
    pub frame: FrameUniform,
    pub frame_buffer: wgpu::Buffer,
    pub frame_group: wgpu::BindGroup,
    pub frame_layout: wgpu::BindGroupLayout,
    pub material_layout: wgpu::BindGroupLayout,
    pub targets: ForwardTargets,
    pub view: PlayerView,
}
impl Fixture {
    pub fn create(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        Self::at_size(device, queue, SIZE, SIZE)
    }
    pub fn at_size(device: &wgpu::Device, queue: &wgpu::Queue, width: u32, height: u32) -> Self {
        let packet = packet();
        Self::with_packet(device, queue, width, height, &packet)
    }
    pub fn with_packet(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
        packet: &RenderPacket,
    ) -> Self {
        let prepared = prepare_scene(packet).unwrap();
        let pbr = prepare_pbr_resources(packet).unwrap();
        let layouts = create_frame_layouts(device);
        let material_layout = create_material_layout(device);
        let scene = GpuScene::new(
            device,
            queue,
            &material_layout,
            None,
            packet,
            scene_content_key(packet),
            &prepared,
            &pbr,
        )
        .unwrap();
        let pipelines = create_mesh_pipelines(
            device,
            &layouts.frame,
            &layouts.shadow,
            &material_layout,
            &create_native_mesh_shader(device),
        );
        let view = PlayerView {
            yaw: 0.,
            pitch: 0.,
            distance: 4.,
            ..Default::default()
        };
        let size = PhysicalSize::new(width, height);
        let mut frame = frame_data_with_camera(size, view, FogSettings::default());
        frame[13] = [0., 0., 0., 3.];
        frame[14] = [1., 0., 1., 0.];
        let shadow = create_shadow_map(device, &layouts.shadow, size, &frame, None, view).unwrap();
        let culling = GpuCulling::new(
            device,
            &scene.instance_buffer,
            &prepare_gpu_culling(packet, &prepared).unwrap(),
            &frame,
            &shadow,
            false,
        )
        .unwrap();
        let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("actual MegaLights frame"),
            contents: bytemuck::cast_slice(&frame),
            usage: wgpu::BufferUsages::UNIFORM
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
        });
        let ies = NativeIesShadingResource::prepare(&[], None).unwrap();
        let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: ies.bytes(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let mut ibl = GpuIblEnvironment::new(device, queue, &disabled_probe_environment()).unwrap();
        let mut targets = ForwardTargets::new(device, size, false);
        if scene.has_transmission() {
            targets.enable_transmission(device);
            ibl.set_scene_opaque_view(targets.scene_opaque_view.as_ref());
        }
        let probe = deep_engine_native::probe_gi_storage::disabled_frame_buffer(device);
        let frame_group = ibl.create_frame_bind_group(
            device,
            &layouts.frame,
            &frame_buffer,
            Some(&ies_buffer),
            &shadow,
            Some(&probe),
            "actual MegaLights",
            true,
        );
        Self {
            scene,
            culling,
            pipelines,
            frame,
            frame_buffer,
            frame_group,
            frame_layout: layouts.frame,
            material_layout,
            targets,
            view,
        }
    }
}

pub(super) fn read_range(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    offset: u64,
    size: u64,
) -> Vec<f32> {
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(buffer, offset, &staging, 0, size);
    queue.submit([encoder.finish()]);
    mapped(device, &staging)
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

pub(super) fn read(device: &wgpu::Device, queue: &wgpu::Queue, buffer: &wgpu::Buffer) -> Vec<f32> {
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: buffer.size(),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, buffer.size());
    queue.submit([encoder.finish()]);
    let bytes = mapped(device, &staging);
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn mapped(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Vec<u8> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |r| {
        sender.send(r).unwrap();
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    buffer.get_mapped_range(..).unwrap().to_vec()
}
pub(super) fn hdr_center(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    targets: &ForwardTargets,
) -> [f32; 4] {
    hdr_pixel(device, queue, targets, SIZE / 2, SIZE / 2)
}
pub(super) fn hdr_pixel(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    targets: &ForwardTargets,
    x: u32,
    y: u32,
) -> [f32; 4] {
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 256,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    let mut source = targets.resolved_texture().as_image_copy();
    source.origin = wgpu::Origin3d { x, y, z: 0 };
    encoder.copy_texture_to_buffer(
        source,
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(1),
            },
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);
    let bytes = mapped(device, &staging);
    std::array::from_fn(|i| {
        deep_engine_native::half_decode::half_to_f32(u16::from_le_bytes(
            bytes[i * 2..i * 2 + 2].try_into().unwrap(),
        ))
    })
}
