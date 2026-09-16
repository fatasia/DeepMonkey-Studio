use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::{
    culling_contract::prepare_gpu_culling, lod_contract::prepare_gpu_lod,
    pbr_texture::prepare_pbr_resources, scene::prepare_scene, scene_bounds::prepare_scene_bounds,
    shadow_cache::ShadowVersion,
};
use wgpu::util::DeviceExt;
use winit::{event_loop::EventLoopProxy, window::Window};

use crate::{
    bloom_pass::BloomPass,
    deep2d_gpu::Deep2dGpuPainter,
    events::GpuEvent,
    forward_targets::ForwardTargets,
    frame_bindings::{create_frame_layouts, create_native_mesh_shader},
    gpu_context::{GpuContext, create_gpu_context},
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_lod::GpuLod,
    gpu_resources::{
        create_shadow_map, frame_data_with_camera, shadow_camera, shadow_ray_direction,
    },
    gpu_scene_cache::GpuSceneCache,
    gpu_shader_materials::GpuShaderMaterials,
    gpu_textures::create_material_layout,
    ibl_probe::IblProbe,
    output_pass::OutputPass,
    pipeline::create_mesh_pipelines,
    player_content::PlayerContent,
    player_state::PlayerView,
    shadow_dirty::{ShadowCasterSet, ShadowDirtyCache, ShadowDirtyEvidence, shader_key},
    shadow_probe::ShadowProbe,
};

use super::{Renderer, RendererFeatures};

pub(super) async fn create_renderer(
    window: Arc<Window>,
    proxy: EventLoopProxy<GpuEvent>,
    renderer_id: u64,
    content: &PlayerContent,
    view: PlayerView,
    features: RendererFeatures,
    activate_surface: bool,
) -> Result<Renderer, String> {
    if features.shadow_probe && features.ibl_probe {
        return Err("shadow and IBL differential probes cannot run in the same frame".into());
    }
    let packet = content.packet();
    if view.clipping != [0.0; 4] && !content.material_bindings.is_empty() {
        return Err("section-unavailable: authored ShaderPackage ABI has no section plane".into());
    }
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
        adapter_info,
        adapter_features,
        device_features,
        config,
        size,
        failures,
    } = create_gpu_context(window, proxy, renderer_id, features.telemetry).await?;
    let diagnostics = crate::player_diagnostics::PlayerDiagnostics::new(
        adapter_info,
        adapter_features,
        device_features,
        features,
        content,
    );

    let yaw = view.yaw;
    let frame = frame_data_with_camera(size, view, features.fog);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let compact_content = super::content_profile::compact_shadow(content, features);
    let frame_layouts = create_frame_layouts(&device);
    let frame_layout = frame_layouts.frame;
    let shadow_frame_layout = frame_layouts.shadow;
    let shadow_map = if compact_content {
        crate::shadow_map::ShadowMap::new_with_options(
            &device,
            &shadow_frame_layout,
            &frame,
            shadow_camera(size, &frame, view),
            shadow_ray_direction(&frame),
            scene_bounds,
            super::content_profile::shadow_options(true),
        )?
    } else {
        create_shadow_map(
            &device,
            &shadow_frame_layout,
            size,
            &frame,
            scene_bounds,
            view,
        )?
    };
    queue.write_buffer(&shadow_map.section_uniform, 0, cast_slice(&view.clipping));
    let shadow_cache = ShadowDirtyCache::default();
    let shadow_version = ShadowVersion::INITIAL;
    let shadow_casters =
        ShadowCasterSet::prepare(packet, &prepared, &prepared_culling, &prepared_lod)?;
    let shadow_shader_key = shader_key(GpuShaderMaterials::content_key(content)?.as_deref());
    let material_layout = create_material_layout(&device);
    let pipelines = if compact_content {
        crate::pipeline::MeshPipelines::for_empty_scene()
    } else {
        let shader = create_native_mesh_shader(&device);
        create_mesh_pipelines(
            &device,
            &frame_layout,
            &shadow_frame_layout,
            &material_layout,
            &shader,
        )
    };
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Deep Engine native frame"),
        contents: cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let mut scene_cache = GpuSceneCache::new(&device, renderer_id)
        .with_budget(crate::gpu_scene_cache::default_budget(&device));
    let candidate = GpuIblEnvironment::new(&device, &queue, &content.environment).and_then(|ibl| {
        let frame_bind_group = ibl.create_frame_bind_group(
            &device,
            &frame_layout,
            &frame_buffer,
            &shadow_map,
            "Deep Engine native frame bindings",
            true,
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
            (features.fog.density() > 0.0).then_some((&forward_targets.depth_view, &frame_buffer)),
        );
        scene_cache
            .stage_scoped(
                &device,
                &queue,
                &material_layout,
                packet,
                content.scene_content_key(),
                &prepared,
                &prepared_pbr,
                content.resource_domain(),
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
                    view.near,
                )?;
                let shadow_keys = shadow_casters.keys(&shadow_map, shadow_shader_key)?;
                display_list
                    .map(|display_list| {
                        let cache = std::sync::Arc::new(
                            crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new(),
                        );
                        Deep2dGpuPainter::new(&device, &queue, config.format, display_list, &cache)
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
                            shadow_casters.clone(),
                            shadow_keys,
                            shadow_shader_key,
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
        shadow_casters,
        shadow_keys,
        shadow_shader_key,
        shadow_version,
        shadow_probe,
        ibl_probe,
        forward_targets,
        bloom,
        output_pass,
    ) = candidate?;
    let cache_metrics = scene_candidate.metrics();
    let scene = scene_cache.commit(scene_candidate)?;
    super::init_report::report_scene_cache(&scene_cache, cache_metrics, &scene, content);
    let telemetry = features
        .telemetry
        .then(|| crate::telemetry::FrameTelemetry::for_device(&device, &queue, renderer_id));
    if activate_surface {
        surface.configure(&device, &config);
    }
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
        shadow_casters,
        shadow_keys,
        shadow_shader_key,
        shadow_version,
        last_shadow_evidence: ShadowDirtyEvidence::default(),
        shadow_probe,
        last_shadow_probe: None,
        ibl_probe,
        forward_targets,
        bloom,
        output_pass,
        frame,
        fog: features.fog,
        yaw,
        view,
        telemetry,
        diagnostics,
        content_profile: super::content_profile::ContentProfileReport::evaluate(content, features),
    })
}
