use bytemuck::cast_slice;
use deep_engine_native::{
    culling_contract::prepare_gpu_culling, lod_contract::prepare_gpu_lod,
    pbr_texture::prepare_pbr_resources, scene::prepare_scene,
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
    player_content::PlayerContent,
    shadow_pass::encode_shadow_cascades,
};

pub struct Snapshot {
    pub hdr: Vec<u8>,
    pub depths: Vec<f32>,
    pub commands: Vec<Vec<[u32; 5]>>,
    pub shadow_size: u32,
    pub nonzero_vertex_offsets: usize,
}

/// Evidence about the ShaderPackage material transaction for one render.
#[derive(Debug, Default, Clone)]
pub struct ShaderMaterialReport {
    pub isolated: Vec<String>,
    pub fallback_materials: usize,
    pub custom_materials: usize,
}

pub async fn render(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    reuse_first_cascade: bool,
) -> Snapshot {
    render_checked(device, queue, content, reuse_first_cascade, None).await
}

pub async fn render_checked(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    reuse_first_cascade: bool,
    foreign_device: Option<&wgpu::Device>,
) -> Snapshot {
    render_reported(device, queue, content, reuse_first_cascade, foreign_device)
        .await
        .0
}

pub async fn render_reported(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    reuse_first_cascade: bool,
    foreign_device: Option<&wgpu::Device>,
) -> (Snapshot, ShaderMaterialReport) {
    let packet = content.packet();
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
    let mut scene = GpuScene::new(
        device,
        queue,
        &material_layout,
        packet,
        content.scene_content_key(),
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
    let ibl = GpuIblEnvironment::new(device, queue, &content.environment).unwrap();
    scene
        .replace_shader_materials(device, content, &frame_buffer, &shadows, &ibl)
        .expect("production Player shader material binding");
    let report = ShaderMaterialReport {
        isolated: scene
            .shader_materials
            .as_ref()
            .map(|materials| materials.isolated.clone())
            .unwrap_or_default(),
        fallback_materials: scene
            .shader_materials
            .as_ref()
            .map(|materials| materials.fallback_materials)
            .unwrap_or(0),
        custom_materials: scene
            .shader_materials
            .as_ref()
            .map(|materials| materials.materials.iter().flatten().count())
            .unwrap_or(0),
    };
    if let Some(custom) = &mut scene.shader_materials {
        assert_eq!(
            custom.materials.iter().flatten().count(),
            content.material_bindings.len() - report.fallback_materials,
            "custom bindings minus isolated fallbacks must stay bound"
        );
        for pass in custom
            .materials
            .iter_mut()
            .flatten()
            .flat_map(|material| material.shadow.iter_mut().flatten())
        {
            assert_eq!(
                pass.frames.len(),
                4,
                "each custom caster binds four fixed frames"
            );
            if reuse_first_cascade {
                // 阴性对照必须能被像素验收抓住，防止四级全部绑定首级矩阵。
                let first = pass.frames[0].clone();
                pass.frames.fill(first);
            }
        }
    }
    if let Some(foreign) = foreign_device {
        crate::shader_material_transactions::verify(
            device,
            foreign,
            content,
            &mut scene,
            &frame_buffer,
            &shadows,
            &ibl,
        );
    }
    let frame_group = ibl.create_frame_bind_group(
        device,
        &layouts.frame,
        &frame_buffer,
        &shadows,
        "LOD verification frame",
        true,
    );
    let targets = ForwardTargets::new(device, size);
    let mut encoder = device.create_command_encoder(&Default::default());
    culling.encode(queue, &mut encoder);
    if let Some(lod) = &lod {
        lod.encode(queue, &mut encoder);
    }
    encode_shadow_cascades(
        &mut encoder,
        &shadows,
        &scene,
        &culling,
        lod.as_ref(),
        &pipelines,
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
    let snapshot = Snapshot {
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
    };
    (snapshot, report)
}
