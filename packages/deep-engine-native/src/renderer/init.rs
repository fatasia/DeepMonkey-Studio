use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::{
    culling_contract::prepare_gpu_culling, lod_contract::prepare_gpu_lod,
    pbr_texture::prepare_pbr_resources, scene::prepare_scene, scene_bounds::prepare_scene_bounds,
    shadow_cache::ShadowVersion,
};
use winit::{event_loop::EventLoopProxy, window::Window};

use crate::{
    bloom_pass::BloomPass,
    events::GpuEvent,
    forward_targets::ForwardTargets,
    frame_bindings::create_frame_layouts,
    gpu_context::{GpuContext, create_gpu_context},
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_lod::GpuLod,
    gpu_occlusion_consume::ConsumeReadbackMode,
    gpu_resources::frame_data_with_camera,
    gpu_scene_cache::GpuSceneCache,
    gpu_shader_materials::GpuShaderMaterials,
    gpu_textures::create_material_layout,
    ibl_probe::IblProbe,
    output_pass::OutputPass,
    player_content::PlayerContent,
    player_state::PlayerView,
    shadow_dirty::{ShadowCasterSet, ShadowDirtyCache, ShadowDirtyEvidence, shader_key},
    shadow_probe::ShadowProbe,
};

use super::{Renderer, RendererFeatures};

mod resources;

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
    if content.background.is_some()
        && (features.bloom.is_active() || features.fog.requires_output_pass())
    {
        return Err(
            "authored solid background requires the native-aces-v1 output without Bloom/Fog".into(),
        );
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
        instance,
        window,
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
    if content.lighting.is_some() && !content.material_bindings.is_empty() {
        return Err(
            "authored directional light is not supported by legacy ShaderPackage material bindings"
                .into(),
        );
    }
    let mut frame = frame_data_with_camera(size, view, features.fog);
    if let Some(lighting) = &content.lighting {
        lighting.apply(&mut frame);
    }
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let compact_content = super::content_profile::compact_shadow(content, features);
    let frame_layouts = create_frame_layouts(&device);
    let frame_layout = frame_layouts.frame;
    let shadow_frame_layout = frame_layouts.shadow;
    let shadow_map = resources::shadow_map(
        &device,
        &shadow_frame_layout,
        size,
        &frame,
        scene_bounds,
        view,
        compact_content,
    )?;
    queue.write_buffer(&shadow_map.section_uniform, 0, cast_slice(&view.clipping));
    let shadow_cache = ShadowDirtyCache::default();
    let shadow_version = ShadowVersion::INITIAL;
    let shadow_casters =
        ShadowCasterSet::prepare(packet, &prepared, &prepared_culling, &prepared_lod)?;
    let shadow_shader_key = shader_key(GpuShaderMaterials::content_key(content)?.as_deref());
    let material_layout = create_material_layout(&device);
    let pipelines = resources::pipelines(
        &device,
        &frame_layout,
        &shadow_frame_layout,
        &material_layout,
        compact_content,
    );
    let frame_buffer = resources::frame_buffer(&device, &frame);
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
        let mut forward_targets = ForwardTargets::new(
            &device,
            super::content_profile::forward_size(
                super::content_profile::compact_forward(content, features),
                size,
            ),
        );
        forward_targets.background = content.background;
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
            features
                .fog
                .requires_output_pass()
                .then_some((&forward_targets.depth_view, &frame_buffer)),
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
                let mut culling = GpuCulling::new(
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
                // R4 生产接线:显式开关(默认关)挂载 MSAA 深度 → HiZ 金字塔
                // + 遮挡判定 + 消费链(view 0)。挂载失败整体报错,不半挂载。
                let hi_z = if super::hi_z_pyramid::occlusion_hiz_enabled() {
                    let pyramid = super::hi_z_pyramid::HiZPyramid::new(
                        &device,
                        &queue,
                        &forward_targets.depth_view,
                        forward_targets.width(),
                        forward_targets.height(),
                    )?;
                    culling.attach_occlusion(
                        &device,
                        &scene.scene().instance_buffer,
                        pyramid.occlusion_source(),
                        &frame,
                        true,
                    )?;
                    culling.attach_occlusion_consume(
                        &device,
                        &scene.scene().instance_buffer,
                        ConsumeReadbackMode::Counts,
                    )?;
                    Some(pyramid)
                } else {
                    None
                };
                let shadow_keys = shadow_casters.keys(&shadow_map, shadow_shader_key)?;
                resources::deep2d(&device, &queue, config.format, display_list).map(|deep2d| {
                    (
                        scene,
                        culling,
                        lod,
                        hi_z,
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
        hi_z,
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
        instance,
        window,
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
        hi_z,
        bloom,
        output_pass,
        frame,
        fog: features.fog,
        lighting: content.lighting.clone(),
        yaw,
        view,
        telemetry,
        diagnostics,
        content_profile: super::content_profile::ContentProfileReport::evaluate(content, features),
    })
}
