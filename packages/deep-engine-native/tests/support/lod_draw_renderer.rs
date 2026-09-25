use bytemuck::cast_slice;
use deep_engine_native::{
    contract::RenderPacket, culling_contract::prepare_gpu_culling, ibl::PreparedIblEnvironment,
    lod_contract::prepare_gpu_lod, pbr_texture::prepare_pbr_resources, scene::prepare_scene,
};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

use crate::{
    forward_targets::ForwardTargets,
    frame_bindings::create_frame_layouts,
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_lod::GpuLod,
    gpu_resources::{create_shadow_map, frame_data},
    gpu_scene::GpuScene,
    gpu_textures::create_material_layout,
    lod_draw_readback,
    mesh_pass::encode_mesh_passes,
    pipeline::create_mesh_pipelines,
    shadow_pass::{CascadeScene, encode_shadow_cascades},
};

pub struct Snapshot {
    pub hdr: Vec<u8>,
    pub depths: Vec<f32>,
    pub commands: Vec<Vec<[u32; 5]>>,
    pub shadow_size: u32,
    pub nonzero_vertex_offsets: usize,
}

pub async fn render(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    packet: &RenderPacket,
    environment: &PreparedIblEnvironment,
) -> Snapshot {
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let prepared = prepare_scene(packet).unwrap();
    let prepared_lod = prepare_gpu_lod(packet, &prepared).unwrap();
    let size = PhysicalSize::new(256, 256);
    let frame = frame_data(size, 0.0);
    let layouts = create_frame_layouts(device);
    let shadows = create_shadow_map(
        device,
        &layouts.shadow,
        size,
        &frame,
        None,
        Default::default(),
    )
    .unwrap();
    let material_layout = create_material_layout(device);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("production mesh + CSM shader"),
        source: wgpu::ShaderSource::Wgsl(
            concat!(
                include_str!("../../assets/shaders/native_mesh_v1.wgsl"),
                "\n",
                include_str!("../../assets/shaders/native_cascaded_shadow_v1.wgsl")
            )
            .into(),
        ),
    });
    let pipelines = create_mesh_pipelines(
        device,
        &layouts.frame,
        &layouts.shadow,
        &material_layout,
        &shader,
    );
    let pbr = prepare_pbr_resources(packet).unwrap();
    let scene = GpuScene::new(
        device,
        queue,
        &material_layout,
        packet,
        crate::player_shader_plan::scene_content_key(packet),
        &prepared,
        &pbr,
    )
    .unwrap();
    let mut culling = GpuCulling::new(
        device,
        &scene.instance_buffer,
        &prepare_gpu_culling(packet, &prepared).unwrap(),
        &frame,
        &shadows,
        false,
    )
    .unwrap();
    let mut lod = GpuLod::new(
        device,
        &scene.instance_buffer,
        &prepared_lod,
        &frame,
        size,
        &shadows,
        deep_engine_native::mesh_abi::CAMERA_NEAR,
    )
    .unwrap();
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let ies =
        deep_engine_native::ies_shading::NativeIesShadingResource::prepare(&[], None).unwrap();
    let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("LOD verification IES identity"),
        contents: ies.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let ibl = GpuIblEnvironment::new(device, queue, environment).unwrap();
    // F3:验证装配无真实探针,绑定 96B 全零占位,开关为 0。
    let probe_frame_buffer = deep_engine_native::probe_gi_storage::disabled_frame_buffer(device);
    let frame_group = ibl.create_frame_bind_group(
        device,
        &layouts.frame,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        Some(&probe_frame_buffer),
        "LOD verification frame",
        true,
    );
    let targets = ForwardTargets::new(device, size, false);
    let mut encoder = device.create_command_encoder(&Default::default());
    culling.encode(queue, &mut encoder);
    if let Some(lod) = &lod {
        lod.encode(queue, &mut encoder);
    }
    encode_shadow_cascades(
        &mut encoder,
        &CascadeScene {
            shadow_map: &shadows,
            scene: &scene,
            culling: &culling,
            lod: lod.as_ref(),
            pipelines: &pipelines,
        },
        u16::MAX,
    );
    encode_mesh_passes(
        &mut encoder,
        &targets,
        &frame_group,
        &scene,
        &culling,
        lod.as_ref(),
        &pipelines,
        0.0,
    );
    let hdr = lod_draw_readback::copy_hdr(device, &mut encoder, targets.resolved_texture());
    let metrics = shadows.metrics();
    let depths = lod_draw_readback::extract_depth(
        device,
        &mut encoder,
        &shadows.view,
        metrics.map_size,
        metrics.cascade_count,
    );
    let command_buffers: Vec<_> = lod
        .as_ref()
        .map(|lod| {
            (0..=metrics.cascade_count as usize)
                .map(|view| {
                    let bytes = prepared_lod.indirect_template.len() as u64 * 20;
                    let output = lod_draw_readback::staging(device, bytes);
                    encoder.copy_buffer_to_buffer(lod.indirect(view), 0, &output, 0, bytes);
                    output
                })
                .collect()
        })
        .unwrap_or_default();
    queue.submit([encoder.finish()]);
    culling.commit_submission();
    if let Some(lod) = &mut lod {
        lod.commit_submission();
    }
    let hdr = lod_draw_readback::mapped_bytes(device, &hdr);
    let depths = cast_slice(&lod_draw_readback::mapped_bytes(device, &depths)).to_vec();
    let commands = command_buffers
        .iter()
        .map(|buffer| cast_slice(&lod_draw_readback::mapped_bytes(device, buffer)).to_vec())
        .collect();
    for error in [
        internal.pop().await,
        memory.pop().await,
        validation.pop().await,
    ] {
        assert!(error.is_none(), "production draw GPU error: {error:?}");
    }
    Snapshot {
        hdr,
        depths,
        commands,
        shadow_size: metrics.map_size,
        nonzero_vertex_offsets: prepared_lod
            .batches
            .iter()
            .flatten()
            .filter(|draw| draw.resident && draw.instance_start > 0)
            .count(),
    }
}
