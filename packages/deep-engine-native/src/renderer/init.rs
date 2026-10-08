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
    gpu_textures::{create_layered_material_layout, create_material_layout},
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
mod rt;

pub(super) async fn create_renderer(
    window: Arc<Window>,
    proxy: EventLoopProxy<GpuEvent>,
    renderer_id: u64,
    content: &PlayerContent,
    view: PlayerView,
    mut features: RendererFeatures,
    activate_surface: bool,
) -> Result<Renderer, String> {
    // Resolve the optional Native quality profile before any GPU allocation so
    // the diagnostics, pass graph and resource budgets observe the same values.
    let quality_profile = super::quality_profile::requested()?;
    if let Some(profile) = quality_profile {
        features = super::quality_profile::apply(features, profile);
    }
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
    let mut initial_preparation_clock =
        super::initial_preparation::InitialPreparationClock::begin(features.telemetry);
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
    if let Some(clock) = initial_preparation_clock.as_mut() {
        clock.scene_prepared()?;
    }
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
    if let Some(clock) = initial_preparation_clock.as_mut() {
        clock.resources_started()?;
    }
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
    let cluster_plan = if let Some(lighting) = &content.lighting {
        lighting.apply(&mut frame);
        // Build the bounded screen-tile plan now so diagnostics and later GPU
        // storage wiring share one deterministic assignment contract.
        diagnostics.note_native_cluster_plan();
        deep_engine_native::clustered_lighting::ClusterGrid::build(
            &lighting.local_lights,
            view,
            size.width,
            size.height,
        )
    } else {
        deep_engine_native::clustered_lighting::ClusterGrid::default()
    };
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
    match initial_preparation_clock.as_mut() {
        Some(clock) => {
            clock
                .note_upload_bytes(u64::try_from(
                    cast_slice::<f32, u8>(&view.clipping).len(),
                )
                .unwrap_or(u64::MAX));
            clock.upload_timed(|| {
                queue.write_buffer(&shadow_map.section_uniform, 0, cast_slice(&view.clipping))
            });
        }
        None => queue.write_buffer(&shadow_map.section_uniform, 0, cast_slice(&view.clipping)),
    }
    if let Some(clock) = initial_preparation_clock.as_mut() {
        clock.resource_stage_prepared(0)?;
    }
    let shadow_cache = ShadowDirtyCache::default();
    let shadow_version = ShadowVersion::INITIAL;
    let shadow_casters =
        ShadowCasterSet::prepare(packet, &prepared, &prepared_culling, &prepared_lod)?;
    let shadow_shader_key = shader_key(GpuShaderMaterials::content_key(content)?.as_deref());
    let material_layout = create_material_layout(&device);
    // I-C23 分层能力门:与 Web deviceSession 同一合同(片段采样纹理 ≥ 19)。
    // 分层材质在包中而能力不足 → 显式报错(fail-closed,不静默丢层);能力
    // 足且包中确有分层材质 → 追加分层颜色管线族(fragment_*_layered)。
    let has_layered_materials = prepared_pbr
        .materials
        .iter()
        .any(|material| material.layered.is_some());
    let layered_ready = device.limits().max_sampled_textures_per_shader_stage
        >= deep_engine_native::pbr_layered::LAYERED_MATERIAL_REQUIRED_TEXTURES;
    if has_layered_materials && !layered_ready {
        return Err(format!(
            "layered materials require {} sampled fragment textures; device provides {}",
            deep_engine_native::pbr_layered::LAYERED_MATERIAL_REQUIRED_TEXTURES,
            device.limits().max_sampled_textures_per_shader_stage
        ));
    }
    let layered_material_layout = layered_ready.then(|| create_layered_material_layout(&device));
    let pipelines = resources::pipelines(
        &device,
        &frame_layout,
        &shadow_frame_layout,
        &material_layout,
        layered_material_layout.as_ref(),
        has_layered_materials,
        compact_content,
    );
    if let Some(clock) = initial_preparation_clock.as_mut() {
        clock.resource_stage_prepared(1)?;
    }
    // F3:旧包/空场景不创建真实 storage(None);非空探针在
    // frame.lightDirection.w 保留通道写 1 开启采样(零=关,旧包逐位不变)。
    // 开关必须在 frame_buffer 固化前写入 uniform。
    // F3:优先消费环境探针网格(网格头模式,开关=2);旧包/空场景不创建真实
    // storage(None),开关保持 0,逐位不变。开关必须在 frame_buffer 固化前写入。
    // P1 质量主线:sdf-gi 生产接线(门控默认关)——无作者探针时,SDF 烘焙→
    // 探针 lattice→全域首追产出记录流(legacy 单层格),经下方既有级联解码/
    // storage/开关路径物化;任何构建失败 fail-closed 回退既有路径并披露原因。
    // 2026-10-06 GPU dispatch 生产化:GPU 腿先试(规划 → 资源创建,独立
    // error scope + 尺寸护栏),就绪走 GPU 三核链;任何失败 fail-closed 回退
    // CPU 权威链(既有通路原样保留,绝不半挂载)。
    let mut sdf_gi_runtime = None;
    let mut probe_grid_records = content
        .probe_grid_records
        .as_deref()
        .filter(|records| !records.is_empty())
        .map(|records| records.to_vec());
    if probe_grid_records.is_none() && super::sdf_gi_runtime::sdf_gi_enabled() {
        let (sources, skipped) = super::sdf_gi_runtime::bake_sources_from_packet(packet);
        let diffuse_mip0 = content
            .environment
            .diffuse
            .mips
            .first()
            .map(|mip| mip.texels.as_slice())
            .unwrap_or(&[]);
        // GPU 腿:共享规划面(拒因与 CPU 腿同款封闭映射;规划失败 = 终局拒,
        // CPU 烘焙对同款合同拒因同判,不再重跑)。资源创建独立 error scope:
        // 设备拒/超限只丢 GPU 腿,不阻塞栅格主通路(fail-closed 回退 CPU)。
        let gpu_leg = match super::sdf_gi_runtime::SdfGiFrameRuntime::plan_gpu(&sources, diffuse_mip0)
        {
            Ok(plan) => {
                let gpu_validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
                let gpu_memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
                let gpu_internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
                let chain =
                    super::sdf_gi_gpu::SdfGiGpuChain::create(&plan, &sources, &device);
                let gpu_errors = [
                    gpu_internal.pop().await,
                    gpu_memory.pop().await,
                    gpu_validation.pop().await,
                ];
                match (chain, gpu_errors.into_iter().flatten().next()) {
                    (Ok(chain), None) => Some(chain),
                    (Ok(chain), Some(_)) => {
                        drop(chain);
                        diagnostics.note_sdf_gi_rejected(
                            super::sdf_gi_runtime::SdfGiReject::GpuDeviceRejected.reason(),
                        );
                        None
                    }
                    (Err(reject), _) => {
                        diagnostics.note_sdf_gi_rejected(reject.reason());
                        None
                    }
                }
            }
            Err(reject) => {
                diagnostics.note_sdf_gi_rejected(reject.reason());
                None
            }
        };
        if let Some(chain) = gpu_leg {
            let mut runtime =
                super::sdf_gi_runtime::SdfGiFrameRuntime::from_gpu_chain(chain, skipped);
            match runtime.initial_records() {
                Ok(records) => {
                    diagnostics.note_native_sdf_gi_runtime_gpu();
                    probe_grid_records = Some(records);
                    sdf_gi_runtime = Some(runtime);
                }
                Err(reject) => diagnostics.note_sdf_gi_rejected(reject.reason()),
            }
        }
        if sdf_gi_runtime.is_none() {
            // CPU 权威腿回退(既有通路;规划面已拒的场景此处会同因拒并再披露)。
            match super::sdf_gi_runtime::SdfGiFrameRuntime::build(&sources, skipped, diffuse_mip0)
            {
                Ok(runtime) => match runtime.initial_records() {
                    Ok(records) => {
                        diagnostics.note_native_sdf_gi_runtime();
                        probe_grid_records = Some(records);
                        sdf_gi_runtime = Some(runtime);
                    }
                    Err(reject) => diagnostics.note_sdf_gi_rejected(reject.reason()),
                },
                Err(reject) => diagnostics.note_sdf_gi_rejected(reject.reason()),
            }
        }
    }
    if let (Some(records), Some(lighting), false) =
        (probe_grid_records.as_mut(), content.lighting.as_ref(), sdf_gi_runtime.is_some())
    {
        let native_records: &mut [crate::probe_gi_abi::IrradianceProbeRecord] =
            bytemuck::cast_slice_mut(records.as_mut_slice());
        if super::native_gi_producer::produce_direct_irradiance(native_records, lighting) {
            diagnostics.note_native_gi_direct_seed();
        }
    }
    // bin 侧 probe_gi_abi 与 lib 的记录是同一 96B POD 布局的两份类型:
    // 经字节切片转译,避免双编译类型的路径不一致。
    let records: &[crate::probe_gi_abi::IrradianceProbeRecord] = match probe_grid_records.as_deref()
    {
        Some(records) if !records.is_empty() => bytemuck::cast_slice(records),
        _ => &[],
    };
    // F3 多层级联:级联解码覆盖 v2 布局(1..4 层,levelCount=1 与旧单层解码逐位
    // 一致)与旧单层网格(record 0 保留区全零)。网格流走级联打包——网格头
    // (padding=baseProbeRecords、v2 布局头合法占用保留区)不在逐记录 ABI 校验
    // 范围内,其结构由级联合同先验;非网格流(旧扁平最近探针)保留 pack_records。
    let probe_grid_cascade = if records.is_empty() {
        None
    } else {
        crate::probe_gi_grid::decode_probe_grid_cascade(records).ok()
    };
    let probe_gi_storage = match &probe_grid_cascade {
        Some(_) => {
            let packed = crate::probe_gi_grid::pack_cascade_records(records)
                .map_err(|error| format!("native probe grid cascade rejected: {error:?}"))?;
            Some(
                ProbeGiStorage::from_packed(&device, packed, records.len()).map_err(|error| {
                    format!("native probe storage contract rejected: {error:?}")
                })?,
            )
        }
        None => ProbeGiStorage::new(&device, records)
            .map_err(|error| format!("native probe storage contract rejected: {error:?}"))?,
    };
    if !records.is_empty() {
        // 网格头模式(>=1.5):旧单层网格头合法,或 v2 级联布局合法;声明 v2 布局
        // 但层级内容非法时 fail-closed 归零(不落最近探针,避免头记录被当扁平
        // 探针采样);旧扁平模式保留 1.0 通道语义。旧包路径逐位不变。
        let legacy_grid = records.len() > 1
            && crate::probe_gi_grid::ProbeGiGridHeader::decode(&records[0]).is_ok();
        let v2_declared = records.len() > 1
            && records[0]
                .reserved
                .first()
                .is_some_and(|value| *value != 0.0);
        frame[crate::probe_gi_storage::FRAME_PROBE_GI_ENABLE_ROW]
            [crate::probe_gi_storage::FRAME_PROBE_GI_ENABLE_LANE] =
            if legacy_grid || probe_grid_cascade.is_some() {
                2.0
            } else if v2_declared {
                0.0
            } else {
                1.0
            };
    }
    // GPU 腿 init 全域首追 dispatch:bake → trace 全域 → update 全域 → 记录面
    // copy 进 probe storage(首帧渲染前 submit;三核绑定面与真机探针门同源,
    // 2026-10-07 两腿真机 PASS)。本 submit 在 init 原子事务 error scope 区间
    // 内 —— dispatch 面错误原子拒 renderer(诚实失败,不半挂载);资源创建
    // 阶段的设备拒/超限已在上方独立 scope fail-closed 回退 CPU 腿。
    if let Some(runtime) = sdf_gi_runtime.as_mut()
        && runtime.gpu_chain_mut().is_some()
        && let Some(storage) = probe_gi_storage.as_ref()
    {
        if let Some(chain) = runtime.gpu_chain_mut() {
            chain.submit_initial_dispatch(&device, &queue, storage.buffer());
        }
    }
    let frame_buffer = resources::frame_buffer(&device, &frame);
    let ies_resource = resources::ies_resource(content.lighting.as_ref())?;
    let ies_buffer = resources::ies_buffer(&device, &ies_resource);
    // binding 11 槽位资源:有探针绑真实 storage,否则绑 96B 全零占位
    // (validity=0,叠加进 ambient 的探针项恒为零)。
    let probe_disabled_buffer = crate::probe_gi_storage::disabled_frame_buffer(&device);
    let probe_frame_buffer = crate::probe_gi_storage::frame_probe_buffer(
        probe_gi_storage.as_ref(),
        &probe_disabled_buffer,
    )
    .clone();
    let mut scene_cache = GpuSceneCache::new(&device, renderer_id)
        .with_budget(crate::gpu_scene_cache::default_budget(&device))
        .with_layered_material_layout(layered_material_layout.clone());
    // 启动期上传计量:IBL 构造(texture 上传,驻留字节估计)与 cluster grid
    // 直发 write_buffer 计入 uploadedBytes/gpuUploadTimeNs;口径声明见
    // initial_preparation.rs json() 的 uploadedBytesCoverage/gpuUploadTimeNote。
    let ibl_environment = match initial_preparation_clock.as_mut() {
        Some(clock) => {
            clock.upload_timed(|| GpuIblEnvironment::new(&device, &queue, &content.environment))
        }
        None => GpuIblEnvironment::new(&device, &queue, &content.environment),
    };
    if let (Some(clock), Ok(ibl)) = (initial_preparation_clock.as_mut(), ibl_environment.as_ref()) {
        clock.note_upload_bytes(ibl.resident_bytes);
        clock.note_upload_bytes(
            u64::try_from(cluster_plan.pack_storage().len()).unwrap_or(u64::MAX / 4) * 4,
        );
    }
    let candidate = ibl_environment.and_then(|mut ibl| {
        match initial_preparation_clock.as_mut() {
            Some(clock) => {
                clock.upload_timed(|| ibl.write_cluster_grid(&queue, &cluster_plan));
            }
            None => ibl.write_cluster_grid(&queue, &cluster_plan),
        }
        diagnostics.note_native_cluster_lookup();
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
        forward_targets.studio_gradient = content.studio_background_gradient;
        if packet.materials.iter().any(|material| material.transmission_factor() > 0.0) {
            forward_targets.enable_transmission(&device);
            ibl.set_scene_opaque_view(forward_targets.scene_opaque_view.as_ref());
        }
        let frame_bind_group = ibl.create_frame_bind_group(
            &device, &frame_layout, &frame_buffer, Some(&ies_buffer), &shadow_map,
            Some(&probe_frame_buffer), "Deep Engine native frame bindings", true,
        );
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
        let output_pass = OutputPass::new_with_profile(
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
            content.display_profile,
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
        if let Some(clock) = initial_preparation_clock.as_mut() {
            clock.resource_stage_prepared(2)?;
        }
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
                scene.scene().prepare_color_pipelines(&pipelines);
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
    if let Some(clock) = initial_preparation_clock.as_mut() {
        clock.resource_stage_prepared(3)?;
    }
    let (rt_residency, rt_frame_bind_group) = rt::prepare(
        &device, &queue, &scene, &mut initial_preparation_clock, &mut diagnostics,
        rt_frame_layout.as_ref(), &material_layout, layered_material_layout.as_ref(),
        has_layered_materials, &ibl, &frame_buffer, &ies_buffer, &shadow_map, &probe_frame_buffer,
    ).await;
    if let Some(clock) = initial_preparation_clock.as_mut() {
        clock.resource_stage_prepared(4)?;
    }
    // P1 质量主线:megaLights RIS 生产接线(门控默认关)。门开且内容带局部灯
    // 才构造帧运行时(决策/统一灯池/IES 行重映射/可见性档位可用性);执行腿
    // 待真机门,现役直射恒走既有簇光。门关 = 零构造。
    let mega_gate = super::megalights_runtime::megalights_gate();
    let mega_lights = if mega_gate != super::megalights_runtime::MegaLightsGate::Off {
        let runtime = content.lighting.as_ref().map(|lighting| {
            super::megalights_runtime::MegaLightsFrameRuntime::build(
                lighting,
                mega_gate,
                Some(ies_resource.rows.as_slice()),
                rt_residency.is_some(),
            )
        });
        if let Some(runtime) = &runtime {
            let forced = runtime.telemetry().decision.reason
                == deep_engine_native::megalights_ris::DirectLightingPathReason::MegalightsForced;
            diagnostics.note_megalights_wired(forced);
        }
        runtime
    } else {
        None
    };
    let telemetry = features
        .telemetry
        .then(|| crate::telemetry::FrameTelemetry::for_device(&device, &queue, renderer_id));
    // T01:质量诊断与 FrameTelemetry 同开关;档名取启动期解析的作者档
    // (TS AuthoredQualityProfile 词汇),未设档为 None,不伪造默认档。
    let quality = features.telemetry.then(|| {
        super::quality_telemetry::QualityTelemetry::new(
            quality_profile.map(super::quality_profile::NativeQualityProfile::telemetry_name),
        )
    });
    if activate_surface {
        surface.configure(&device, &config);
    }
    #[cfg(target_arch = "wasm32")]
    let editor_overlay = super::editor_overlay::EditorOverlay::new(&device, config.format);
    let initial_preparation = initial_preparation_clock
        .map(|clock| clock.finish(renderer_id))
        .transpose()?;
    let studio_background = content.studio_background_gradient.then(|| deep_engine_native::studio_background::StudioBackground::new(
        &device, &queue, &frame_buffer,
        deep_engine_native::mesh_abi::FORWARD_COLOR_FORMAT,
        deep_engine_native::mesh_abi::FORWARD_SAMPLE_COUNT,
    ));
    Ok(Renderer {
        id: renderer_id,
        studio_background,
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
        #[cfg(target_arch = "wasm32")]
        editor_overlay,
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
        sdf_gi: sdf_gi_runtime,
        mega_lights,
        forward_depth_epoch: 1,
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
        initial_preparation,
        quality,
        diagnostics,
        content_profile: super::content_profile::ContentProfileReport::evaluate(content, features),
    })
}
