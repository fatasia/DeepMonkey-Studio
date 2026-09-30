use bytemuck::cast_slice;
use deep_engine_native::{
    culling_contract::prepare_gpu_culling, lod_contract::prepare_gpu_lod,
    pbr_texture::prepare_pbr_resources, scene::prepare_scene,
};
use wgpu::util::DeviceExt;

use crate::{
    forward_targets::ForwardTargets,
    frame_bindings::{create_frame_layouts, create_native_mesh_shader},
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_lod::GpuLod,
    gpu_resources::create_shadow_map,
    gpu_scene::GpuScene,
    gpu_textures::create_material_layout,
    lod_draw_readback,
    pipeline::create_mesh_pipelines,
    player_content::PlayerContent,
    shadow_pass::{CascadeScene, encode_shadow_cascades},
};

#[path = "shader_material_observers.rs"]
mod observers;
pub use observers::{
    FrameObservation, ShaderMaterialReport, Snapshot, render_reported,
    render_with_frame_observation, render_with_live_components,
};

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

async fn render_observed(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    reuse_first_cascade: bool,
    foreign_device: Option<&wgpu::Device>,
    observer: Option<&mut dyn FnMut(&Snapshot)>,
    frame_observation: Option<&mut FrameObservation<'_>>,
) -> (Snapshot, ShaderMaterialReport) {
    let packet = content.packet();
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let prepared = prepare_scene(packet).unwrap();
    let prepared_lod = prepare_gpu_lod(packet, &prepared).unwrap();
    let (size, frame, shadow_view) = observers::frame_parameters(frame_observation.as_deref());
    let layouts = create_frame_layouts(device);
    let shadows =
        create_shadow_map(device, &layouts.shadow, size, &frame, None, shadow_view).unwrap();
    let material_layout = create_material_layout(device);
    let shader = create_native_mesh_shader(device);
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
        shadow_view.near,
    )
    .unwrap();
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let empty: [deep_engine_native::local_lighting::LocalLight; 0] = [];
    let ies = deep_engine_native::ies_shading::NativeIesShadingResource::prepare(
        content
            .lighting
            .as_ref()
            .map_or(&empty, |value| value.local_lights.as_slice()),
        content
            .lighting
            .as_ref()
            .and_then(|value| value.light_profiles.as_deref()),
    )
    .unwrap();
    let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("shader material verification IES"),
        contents: ies.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
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
    observers::encode_frame(
        &mut encoder,
        &targets,
        &frame_group,
        &scene,
        &culling,
        lod.as_ref(),
        &pipelines,
        frame_observation.is_some(),
    );
    if let Some(observation) = frame_observation {
        (observation.encode)(device, &mut encoder, &targets, &frame);
    }
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
    if let Some(observer) = observer {
        observer(&snapshot);
        // Keep the production owners borrowed after the loss observer has returned.
        let _ = (
            &scene,
            &shadows,
            &targets,
            &pipelines,
            &culling,
            &lod,
            &frame_group,
            &ibl,
        );
    }
    (snapshot, report)
}
