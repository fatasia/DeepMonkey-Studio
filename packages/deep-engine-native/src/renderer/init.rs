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
    probe_gi_storage::ProbeGiStorage,
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
    let mut diagnostics = crate::player_diagnostics::PlayerDiagnostics::new(
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
    frame[9][3] = f32::from(!matches!(
        content.environment.provenance,
        deep_engine_native::ibl::IblProvenance::DisabledProbe
    ));
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
    // RT 扩展 layout 仅在 ray query 设备上存在(双 layout,见 frame_bindings)。
    let rt_frame_layout = frame_layouts.frame_rt;
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
    // F3:旧包/空场景不创建真实 storage(None);非空探针在
    // frame.lightDirection.w 保留通道写 1 开启采样(零=关,旧包逐位不变)。
    // 开关必须在 frame_buffer 固化前写入 uniform。
    let probe_gi_storage = ProbeGiStorage::new(&device, &[])
        .map_err(|error| format!("native probe storage contract rejected: {error:?}"))?;
    if probe_gi_storage.is_some() {
        frame[crate::probe_gi_storage::FRAME_PROBE_GI_ENABLE_ROW]
            [crate::probe_gi_storage::FRAME_PROBE_GI_ENABLE_LANE] = 1.0;
    }
    let frame_buffer = resources::frame_buffer(&device, &frame);
    let ies_buffer = resources::ies_buffer(&device, content.lighting.as_ref())?;
    // binding 11 槽位资源:有探针绑真实 storage,否则绑 96B 全零占位
    // (validity=0,叠加进 ambient 的探针项恒为零)。
    let probe_disabled_buffer = crate::probe_gi_storage::disabled_frame_buffer(&device);
    let probe_frame_buffer = crate::probe_gi_storage::frame_probe_buffer(
        probe_gi_storage.as_ref(),
        &probe_disabled_buffer,
    )
    .clone();
    let mut scene_cache = GpuSceneCache::new(&device, renderer_id)
        .with_budget(crate::gpu_scene_cache::default_budget(&device));
    let candidate = GpuIblEnvironment::new(&device, &queue, &content.environment).and_then(|ibl| {
        let frame_bind_group = ibl.create_frame_bind_group(
            &device,
            &frame_layout,
            &frame_buffer,
            Some(&ies_buffer),
            &shadow_map,
            Some(&probe_frame_buffer),
            "Deep Engine native frame bindings",
            true,
        );
        let mut forward_targets = ForwardTargets::new(
            &device,
            super::content_profile::forward_size(
                super::content_profile::compact_forward(content, features),
                size,
            ),
            packet
                .instances
                .iter()
                .any(|instance| instance.outline == Some(true)),
        );
        forward_targets.background = content.background;
        let shadow_probe = features.shadow_probe.then(|| {
            ShadowProbe::new(
                &device,
                &frame_layout,
                &shadow_map,
                &frame_buffer,
                &ies_buffer,
                &probe_frame_buffer,
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
                    &ies_buffer,
                    &probe_frame_buffer,
                    size,
                )
            })
            .transpose()?;
        let bloom = BloomPass::new(&device, &forward_targets.hdr_view, size, features.bloom)?;
        // 作者色彩分级（v9 六通道）：仅非中性档写非零 uniform；中性/缺省档
        // 传 None，输出 shader 的全零分支逐位恒等，渲染路径与旧包一致。
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
            content
                .author_grading
                .filter(|grading| !grading.is_neutral())
                .map(|grading| grading.pack()),
        );
        let mut outline_pass = crate::outline_pass::OutlinePass::new(&device, config.format);
        outline_pass.rebind(
            &device,
            forward_targets.outline.as_ref().map(|outline| {
                (
                    &outline.mask_view,
                    &outline.depth_view,
                    &forward_targets.depth_view,
                )
            }),
        );
        let outline_shader = crate::frame_bindings::create_native_mesh_shader(&device);
        let outline_mask_pipelines = crate::outline_pass::OutlineMaskPipelines::new(
            &device,
            &frame_layout,
            &material_layout,
            &outline_shader,
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
                // R4 生产接线:auto 默认挂载 MSAA 深度 → HiZ 金字塔 + 遮挡判定
                // + 消费链(view 0)；显式 off 才回退。挂载失败整体报错,不半挂载。
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
                        ies_buffer,
                        probe_frame_buffer,
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
                        outline_pass,
                        outline_mask_pipelines,
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
        ies_buffer,
        probe_frame_buffer,
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
        outline_pass,
        outline_mask_pipelines,
    ) = candidate?;
    #[cfg(windows)]
    let dashboard_video = {
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = match (content.dashboard.as_ref(), deep2d.as_ref()) {
            (Some(runtime), Some(painter)) => {
                crate::dashboard_video_gpu::DashboardVideoGpuCompositor::new(
                    &device,
                    &queue,
                    config.format,
                    runtime,
                    painter.dashboard_video_slots(),
                    painter.logical_size(),
                )
            }
            _ => Ok(None),
        };
        let errors = [
            internal.pop().await,
            memory.pop().await,
            validation.pop().await,
        ];
        if let Some(error) = errors.into_iter().flatten().next() {
            return Err(format!(
                "native dashboard video GPU transaction rejected atomically: {error}"
            ));
        }
        candidate?
    };
    let cache_metrics = scene_candidate.metrics();
    let scene = scene_cache.commit(scene_candidate)?;
    super::init_report::report_scene_cache(&scene_cache, cache_metrics, &scene, content);
    // F2:硬件 RT 驻留(静态实例 BLAS 缓存 + 场景 TLAS)在栅格原子事务之外
    // 建立——任何拒绝都 fail-closed 关闭 RT 并记录诊断原因,绝不阻塞栅格主通路。
    let mut rt_residency = match super::rt_residency::RtSceneResidency::build(&device, &scene) {
        Ok((residency, blas_encoder, tlas_encoder)) => {
            // BLAS 必须先于 TLAS 完成;单次 submit 内 FIFO 保证 GPU 执行序。
            queue.submit([blas_encoder.finish(), tlas_encoder.finish()]);
            diagnostics.note_rt_tlas_resident();
            Some(residency)
        }
        // 能力缺失维持既有 adapter/device 精确原因,不覆盖。
        Err(super::rt_residency::RtResidencyReject::MissingFeature) => None,
        Err(reject) => {
            diagnostics.note_rt_tlas_rejected(reject.reason());
            None
        }
    };
    let rt_frame_bind_group = match (&rt_residency, &rt_frame_layout) {
        (Some(residency), Some(layout)) => Some(ibl.create_rt_frame_bind_group(
            &device,
            layout,
            &frame_buffer,
            Some(&ies_buffer),
            &shadow_map,
            residency.tlas(),
            Some(&probe_frame_buffer),
            "Deep Engine native RT frame bindings",
        )),
        _ => None,
    };
    // F2 pixel:opaque/MASK 方向阴影 Ray Query 管线族。与驻留同在栅格原子
    // 事务之外:创建走独立 validation error scope,失败仅丢弃管线族并记录
    // 精确原因(fail-closed 回退栅格),不阻塞渲染器创建。含 custom shader
    // 批次的场景不创建——其批次只能绑定普通 frame layout,RT frame bind
    // group 无法与之混用,整帧回退栅格由帧循环判定。
    let rt_pixel_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    if let (Some(residency), Some(layout)) = (rt_residency.as_mut(), rt_frame_layout.as_ref())
        && scene.shader_materials.is_none()
    {
        let rt_shader = crate::frame_bindings::create_native_mesh_rt_shader(&device);
        residency.install_pixel_pipelines(crate::pipeline::create_rt_mesh_pipelines(
            &device,
            layout,
            &material_layout,
            &rt_shader,
        ));
    }
    match rt_pixel_scope.pop().await {
        Some(_) => {
            if let Some(residency) = rt_residency.as_mut() {
                residency.drop_pixel_pipelines();
            }
            diagnostics.note_rt_pixel_rejected();
        }
        None if rt_residency
            .as_ref()
            .is_some_and(|residency| residency.pixel_pipelines().is_some()) =>
        {
            // 驻留 + RT frame 绑定 + Ray Query 管线族全部就绪:诊断从
            // tlas_resident_pixel_pending 升级为真实像素消费态。
            diagnostics.note_rt_directional_shadow_pixels();
        }
        None => {}
    }
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
        #[cfg(windows)]
        dashboard_video,
        frame_buffer,
        ies_buffer,
        probe_frame_buffer,
        frame_layout,
        frame_bind_group,
        rt_frame_layout,
        rt_frame_bind_group,
        rt_residency,
        probe_gi_storage,
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
        outline_pass,
        outline_mask_pipelines,
        frame,
        fog: features.fog,
        lighting: content.lighting.clone(),
        yaw,
        view,
        coordinate_frame_revision: content.coordinate_frame_revision(),
        telemetry,
        diagnostics,
        content_profile: super::content_profile::ContentProfileReport::evaluate(content, features),
    })
}
