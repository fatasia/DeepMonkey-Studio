use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::{
    culling_contract::prepare_gpu_culling,
    lod_contract::prepare_gpu_lod,
    pbr_texture::prepare_pbr_resources,
    scene::prepare_scene,
    scene_bounds::prepare_scene_bounds,
    shadow_cache::{ShadowCache, ShadowVersion},
};
use wgpu::util::DeviceExt;
use winit::{event_loop::EventLoopProxy, window::Window};

use crate::{
    bloom_pass::BloomPass,
    deep2d_gpu::Deep2dGpuPainter,
    events::GpuEvent,
    forward_targets::ForwardTargets,
    frame_bindings::create_frame_layouts,
    gpu_context::{GpuContext, create_gpu_context},
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_lod::GpuLod,
    gpu_resources::{create_shadow_map, frame_data},
    gpu_scene_cache::GpuSceneCache,
    gpu_textures::create_material_layout,
    ibl_probe::IblProbe,
    output_pass::OutputPass,
    pipeline::create_mesh_pipelines,
    player_content::PlayerContent,
    player_state::PlayerView,
    shadow_probe::ShadowProbe,
};

use super::{Renderer, RendererFeatures};

const SHADER: &str = concat!(
    include_str!("../../assets/shaders/native_mesh_v1.wgsl"),
    "\n",
    include_str!("../../assets/shaders/native_cascaded_shadow_v1.wgsl")
);

pub(super) async fn create_renderer(
    window: Arc<Window>,
    proxy: EventLoopProxy<GpuEvent>,
    renderer_id: u64,
    content: &PlayerContent,
    view: PlayerView,
    features: RendererFeatures,
) -> Result<Renderer, String> {
    if features.shadow_probe && features.ibl_probe {
        return Err("shadow and IBL differential probes cannot run in the same frame".into());
    }
    let packet = content.packet();
    let display_list = content.deep2d.as_ref();
    let prepared = prepare_scene(packet)?;
    let prepared_culling = prepare_gpu_culling(packet, &prepared)?;
    let prepared_lod = prepare_gpu_lod(packet, &prepared)?;
    let prepared_pbr = prepare_pbr_resources(packet)?;
    let scene_bounds = prepare_scene_bounds(packet)?;
    let GpuContext {
        surface,
        device,
        queue,
        config,
        size,
        failures,
    } = create_gpu_context(window, proxy, renderer_id).await?;

    let yaw = view.yaw;
    let frame = frame_data(size, yaw);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native mesh shader v1"),
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    let frame_layouts = create_frame_layouts(&device);
    let frame_layout = frame_layouts.frame;
    let shadow_frame_layout = frame_layouts.shadow;
    let shadow_map = create_shadow_map(&device, &shadow_frame_layout, size, &frame, scene_bounds)?;
    let shadow_cache = ShadowCache::default();
    let shadow_version = ShadowVersion::INITIAL;
    let material_layout = create_material_layout(&device);
    let pipelines = create_mesh_pipelines(
        &device,
        &frame_layout,
        &shadow_frame_layout,
        &material_layout,
        &shader,
    );
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Deep Engine native frame"),
        contents: cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let mut scene_cache = GpuSceneCache::new(&device, renderer_id);
    let candidate = GpuIblEnvironment::new(&device, &queue, &content.environment).and_then(|ibl| {
        let frame_bind_group = ibl.create_frame_bind_group(
            &device,
            &frame_layout,
            &frame_buffer,
            &shadow_map,
            "Deep Engine native frame bindings",
        );
        let forward_targets = ForwardTargets::new(&device, size);
        let shadow_probe = features.shadow_probe.then(|| {
            ShadowProbe::new(
                &device,
                &frame_layout,
                &shadow_map,
                &frame_buffer,
                &ibl,
                size,
            )
        });
        let ibl_probe = features
            .ibl_probe
            .then(|| {
                IblProbe::new(
                    &device,
                    &queue,
                    &frame_layout,
                    &shadow_map,
                    &frame_buffer,
                    size,
                )
            })
            .transpose()?;
        let bloom = BloomPass::new(&device, &forward_targets.hdr_view, size, features.bloom)?;
        let output_pass = OutputPass::new(
            &device,
            config.format,
            &forward_targets.hdr_view,
            bloom
                .as_ref()
                .map(|bloom| (bloom.output_view(), bloom.settings().intensity)),
        );
        scene_cache
            .stage(
                &device,
                &queue,
                &material_layout,
                packet,
                content.scene_content_key(),
                &prepared,
                &prepared_pbr,
            )
            .and_then(|mut scene| {
                scene.scene_mut().replace_shader_materials(
                    &device,
                    content,
                    &frame_buffer,
                    &shadow_map,
                    &ibl,
                )?;
                let culling = GpuCulling::new(
                    &device,
                    &scene.scene().instance_buffer,
                    &prepared_culling,
                    &frame,
                    &shadow_map,
                    features.shadow_probe,
                )?;
                let lod = GpuLod::new(
                    &device,
                    &scene.scene().instance_buffer,
                    &prepared_lod,
                    &frame,
                    size,
                    &shadow_map,
                )?;
                display_list
                    .map(|display_list| {
                        Deep2dGpuPainter::new(&device, &queue, config.format, display_list)
                    })
                    .transpose()
                    .map(|deep2d| {
                        (
                            scene,
                            culling,
                            lod,
                            deep2d,
                            frame_buffer,
                            frame_layout,
                            frame_bind_group,
                            shadow_map,
                            ibl,
                            shadow_cache,
                            shadow_version,
                            shadow_probe,
                            ibl_probe,
                            forward_targets,
                            bloom,
                            output_pass,
                        )
                    })
            })
    });
    let gpu_errors = [
        internal_scope.pop().await,
        memory_scope.pop().await,
        validation_scope.pop().await,
    ];
    if let Some(error) = gpu_errors.into_iter().flatten().next() {
        drop(candidate);
        return Err(format!(
            "native GPU resource transaction rejected atomically: {error}"
        ));
    }
    let (
        scene_candidate,
        culling,
        lod,
        deep2d,
        frame_buffer,
        frame_layout,
        frame_bind_group,
        shadow_map,
        ibl,
        shadow_cache,
        shadow_version,
        shadow_probe,
        ibl_probe,
        forward_targets,
        bloom,
        output_pass,
    ) = candidate?;
    let cache_metrics = scene_candidate.metrics();
    let scene = scene_cache.commit(scene_candidate)?;
    let cache_live = scene_cache.live_resources();
    println!(
        "native scene cache epoch {}: geometry upload/reuse={}/{}, texture={}/{}, material={}/{}, instance upload/reuse={}/{} bytes uploaded/copied={}/{}",
        scene_cache.epoch(),
        cache_metrics.geometry_uploads,
        cache_metrics.geometry_reuses,
        cache_metrics.texture_uploads,
        cache_metrics.texture_reuses,
        cache_metrics.material_uploads,
        cache_metrics.material_reuses,
        cache_metrics.instance_buffer_uploads,
        cache_metrics.instance_buffer_reuses,
        cache_metrics.instance_uploaded_bytes,
        cache_metrics.instance_copied_bytes,
    );
    println!(
        "native scene cache live: geometry={} texture={} material={} instances={}",
        cache_live.geometries,
        cache_live.textures,
        cache_live.materials,
        cache_live.instance_buffers,
    );
    if let Some(materials) = &scene.shader_materials {
        println!(
            "native Player ShaderPackage materials ready: packages={} materials={}",
            content.shader_packages.len(),
            materials.materials.iter().flatten().count()
        );
    }
    surface.configure(&device, &config);
    Ok(Renderer {
        id: renderer_id,
        surface,
        device,
        queue,
        failures,
        config,
        size,
        pipelines,
        material_layout,
        _scene_cache: scene_cache,
        scene,
        culling,
        lod,
        deep2d,
        frame_buffer,
        frame_layout,
        frame_bind_group,
        shadow_map,
        ibl,
        shadow_cache,
        shadow_version,
        shadow_probe,
        last_shadow_probe: None,
        ibl_probe,
        forward_targets,
        bloom,
        output_pass,
        frame,
        yaw,
    })
}
