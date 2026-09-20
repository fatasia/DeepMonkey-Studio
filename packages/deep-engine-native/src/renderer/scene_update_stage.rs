use deep_engine_native::{
    culling_contract::prepare_gpu_culling, lod_contract::prepare_gpu_lod,
    mesh_abi::MATERIAL_UNIFORM_FLOATS, pbr_texture::prepare_material_uniform_rows,
    pbr_texture::prepare_pbr_resources, scene::prepare_scene, scene::recompute_surface_flags,
    scene_bounds::prepare_scene_bounds,
};

use crate::renderer::material_resource_diff::{
    MaterialResourceDiff, classify_material_resources, instance_material_words_unchanged,
};
use crate::renderer::scene_instance_diff::{SceneInstanceDiff, diff_scene_instances};
use crate::{
    deep2d_gpu::{Deep2dFrameContext, Deep2dGpuPainter},
    deep2d_gpu_cache::{Deep2dCacheStats, Deep2dGpuAssetCache},
    gpu_culling::GpuCulling,
    gpu_lod::GpuLod,
    gpu_resources::{shadow_camera, shadow_ray_direction},
    gpu_scene_cache::{GpuSceneCacheMetrics, GpuSceneCandidate},
    gpu_shader_materials::GpuShaderMaterials,
    player_content::PlayerContent,
    shadow_dirty::{ShadowCascadeKey, ShadowCasterSet, shader_key},
    shadow_map_update::ShadowMapUpdate,
    shadow_update_classify::classify_shadow_relevance,
};

use super::Renderer;
#[path = "dashboard_update.rs"]
mod dashboard_update;
#[path = "drop_preview.rs"]
mod drop_preview;
#[path = "packet_present.rs"]
mod packet_present;

pub(crate) struct StagedDeep2dUpdate {
    candidate: Option<Deep2dGpuPainter>,
    stats: Deep2dCacheStats,
    /// R6-2 细分:Deep2D staging 准备耗时(CPU 侧,含错误域 pop)。
    prepare_ns: u64,
}

pub(crate) enum StagedRenderPacketUpdate {
    Noop,
    Replace(Box<StagedRenderPacketPayload>),
    /// C3 transform-only 快路径:实例身份/几何/材质/纹理全同,仅 transform 子集变化。
    TransformRefresh(Box<StagedTransformRefresh>),
    /// C3 uniform-only 材质快路径:实例/几何/纹理全同且材质 id/数量不变,
    /// 仅材质数值 uniform 变化。rows 为 stage 侧 prepare_material_uniform
    /// 的输出,publish 按行原位写缓冲。
    MaterialUniformRefresh(Box<StagedMaterialUniformRefresh>),
    /// C3 receive-shadow-only 快路径:cast_shadow/实例身份/几何/材质/纹理/
    /// LOD 全同,仅 receive_shadow 子集变化。receive 标志只进实例词 31
    /// (surface flags)且不参与批键——批布局与实例顺序稳定,publish 单行
    /// 原位写;阴影贴图与 caster 集合不受影响,不失效阴影版本。
    ShadowFlagRefresh(Box<StagedShadowFlagRefresh>),
}

pub(crate) struct StagedTransformRefresh {
    pub(crate) rows: Vec<(usize, [f32; 16])>,
    pub(crate) scene_content_key: u64,
}

pub(crate) struct StagedMaterialUniformRefresh {
    pub(crate) rows: Vec<(usize, [f32; MATERIAL_UNIFORM_FLOATS])>,
    pub(crate) scene_content_key: u64,
}

pub(crate) struct StagedShadowFlagRefresh {
    pub(crate) rows: Vec<(usize, f32)>,
    pub(crate) scene_content_key: u64,
}

pub(crate) struct StagedRenderPacketPayload {
    scene: GpuSceneCandidate,
    culling: GpuCulling,
    lod: Option<GpuLod>,
    shadow_update: ShadowMapUpdate,
    shadow_casters: ShadowCasterSet,
    shadow_keys: Vec<ShadowCascadeKey>,
    shadow_shader_key: u64,
    invalidate_shadow: bool,
    /// R6-2 细分:staging 的纯 CPU 场景准备耗时(校验/遍历/派生数据)。
    scene_update_ns: u64,
    /// R6-2 细分:GPU 资源准备与上传暂存耗时(stage_scoped 闭包 + 错误域)。
    resource_upload_ns: u64,
    /// C3 切片三:true = 资源复用刷新 staging(跳过纹理解码与整包内容哈希),
    /// false = 全量 stage_scoped。测试与遥测的路由证据。
    pub(crate) staged_via_resource_reuse: bool,
}

impl Renderer {
    /// `context` 由宿主装配层给出(见 `deep2d_gpu::deep2d_frame_context`):
    /// 资源代次取目标 epoch,物理缩放取 letterbox 实际比值。
    /// 传 `None` 退回第一批行为(Noop 维度),供未接线路径使用。
    pub(crate) async fn stage_deep2d_update_inner(
        &self,
        content: Option<&deep_engine_native::deep2d::Deep2dRuntimeContent>,
        context: Option<Deep2dFrameContext>,
    ) -> Result<StagedDeep2dUpdate, String> {
        let Some(content) = content else {
            return Ok(StagedDeep2dUpdate {
                candidate: None,
                stats: Deep2dCacheStats::default(),
                prepare_ns: 0,
            });
        };
        let prepare_started = std::time::Instant::now();
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = match &self.deep2d {
            Some(active) => match context {
                Some(context) => active.stage_update_with_context(
                    &self.device,
                    &self.queue,
                    self.config.format,
                    content,
                    context,
                ),
                None => active.stage_update(&self.device, &self.queue, self.config.format, content),
            },
            None => {
                let cache = std::sync::Arc::new(Deep2dGpuAssetCache::new());
                match context {
                    Some(context) => Deep2dGpuPainter::new_with_context(
                        &self.device,
                        &self.queue,
                        self.config.format,
                        content,
                        &cache,
                        context,
                    ),
                    None => Deep2dGpuPainter::new(
                        &self.device,
                        &self.queue,
                        self.config.format,
                        content,
                        &cache,
                    ),
                }
            }
        };
        let gpu_errors = [
            internal.pop().await,
            memory.pop().await,
            validation.pop().await,
        ];
        if let Some(error) = gpu_errors.into_iter().flatten().next() {
            drop(candidate);
            return Err(format!(
                "native Deep2D candidate rejected atomically: {error}"
            ));
        }
        let candidate = candidate?;
        Ok(StagedDeep2dUpdate {
            stats: candidate.cache_stats(),
            candidate: Some(candidate),
            prepare_ns: u64::try_from(prepare_started.elapsed().as_nanos()).unwrap_or(u64::MAX),
        })
    }

    pub(crate) fn publish_deep2d_update(&mut self, staged: StagedDeep2dUpdate) -> Deep2dCacheStats {
        // Noop(无候选)不产生样本:保持"样本=一次真实 staging 提交"的合同。
        if staged.candidate.is_some()
            && let Some(telemetry) = self.telemetry.as_mut()
        {
            telemetry.record_deep2d_prepare(staged.prepare_ns);
        }
        self.deep2d = staged.candidate;
        staged.stats
    }

    pub(crate) async fn stage_render_packet_update(
        &self,
        previous_packet: &deep_engine_native::contract::RenderPacket,
        content: &PlayerContent,
    ) -> Result<StagedRenderPacketUpdate, String> {
        if crate::gpu_ibl::GpuIblEnvironment::source_identity(&content.environment)
            != self.ibl.identity
            || content.background != self.forward_targets.background
        {
            return Err(
                "native RenderPacket update changed IBL identity; rebuild the renderer epoch"
                    .into(),
            );
        }
        self.stage_packet_with_environment(previous_packet, content, &self.ibl, false)
            .await
    }

    pub(super) async fn stage_packet_with_environment(
        &self,
        previous_packet: &deep_engine_native::contract::RenderPacket,
        content: &PlayerContent,
        ibl: &crate::gpu_ibl::GpuIblEnvironment,
        environment_changed: bool,
    ) -> Result<StagedRenderPacketUpdate, String> {
        if self.requires_content_rebuild(content) {
            return Err(
                "native content allocation profile changed; stage a complete renderer epoch".into(),
            );
        }
        let shader_signature = GpuShaderMaterials::content_key(content)?;
        let shadow_shader_key = shader_key(shader_signature.as_deref());
        if !environment_changed
            && self._scene_cache.active_domain() == content.resource_domain()
            && self
                .scene
                .matches_content(content.scene_content_key(), shader_signature.as_deref())
        {
            return Ok(StagedRenderPacketUpdate::Noop);
        }
        // R6-2 细分计时:scene_update = 纯 CPU 场景准备(分类/校验/遍历/
        // 批处理/派生数据/阴影 stage),resource_upload = GPU 资源创建与上传
        // 暂存(stage_scoped 闭包 + 错误域 pop,含内嵌校验等待的墙钟时间)。
        // 两段都随 payload 走,由 publish(唯一提交点)记入遥测。
        let prepare_started = std::time::Instant::now();
        let packet = content.packet();
        // C3 快路径判别:实例 diff + 几何/纹理 id+revision 守卫先行,任一不过
        // 回落全量路径。四条互斥快路径:transform-only 与 uniform-only 材质
        // (切片一)、receive-shadow-only 单行写与 LOD/cast 阴影标志的资源复
        // 用刷新(切片三)。实例有变化时材质分支不参与(diff 非 Identical);
        // 材质有变化时 transform 分支不参与(materials 守卫不过);receive-only
        // 要求材质资源与实例词字段全同(词 31 唯一自由度);刷新 staging 要求
        // 材质资源身份不变(已驻留 GpuMaterial 复用的前提)。
        let geometries_equal = previous_packet
            .geometries
            .iter()
            .map(|geometry| (&geometry.id, geometry.revision))
            .eq(packet
                .geometries
                .iter()
                .map(|geometry| (&geometry.id, geometry.revision)));
        let textures_equal = previous_packet
            .textures
            .iter()
            .map(|texture| (&texture.id, texture.revision))
            .eq(packet
                .textures
                .iter()
                .map(|texture| (&texture.id, texture.revision)));
        match diff_scene_instances(&previous_packet.instances, &packet.instances) {
            SceneInstanceDiff::TransformOnly { changed_indices } => {
                let materials_equal =
                    format!("{:?}", previous_packet.materials) == format!("{:?}", packet.materials);
                if materials_equal && geometries_equal && textures_equal {
                    let rows: Vec<(usize, [f32; 16])> = changed_indices
                        .iter()
                        .map(|index| (*index as usize, packet.instances[*index as usize].transform))
                        .collect();
                    return Ok(StagedRenderPacketUpdate::TransformRefresh(Box::new(
                        StagedTransformRefresh {
                            rows,
                            scene_content_key: content.scene_content_key(),
                        },
                    )));
                }
            }
            SceneInstanceDiff::Identical => {
                // C3 uniform-only 材质快路径:守卫五关(实例 Identical → 实例
                // 引用的材质名与 transform 全不变;几何/纹理 id+revision 全同;
                // 材质数量与 id 由 classify 守卫;实例词字段 base_color/metallic
                // 等由 instance_material_words_unchanged 守卫——它们走实例缓冲
                // 而非材质 uniform,同帧变化必须回落全量路径)。材质行构造只
                // 解析纹理索引与 uniform 数值,不解码纹理;行构造失败(合同
                // 之外)回落全量路径,由全量校验给出错误呈现。
                if geometries_equal
                    && textures_equal
                    && instance_material_words_unchanged(
                        &previous_packet.materials,
                        &packet.materials,
                    )
                    && let (Ok(previous_rows), Ok(next_rows)) = (
                        prepare_material_uniform_rows(previous_packet),
                        prepare_material_uniform_rows(packet),
                    )
                    && let MaterialResourceDiff::UniformOnly { changed_indices } =
                        classify_material_resources(&previous_rows, &next_rows)
                {
                    let rows: Vec<(usize, [f32; MATERIAL_UNIFORM_FLOATS])> = changed_indices
                        .iter()
                        .map(|&index| (index, next_rows[index].uniform))
                        .collect();
                    return Ok(StagedRenderPacketUpdate::MaterialUniformRefresh(Box::new(
                        StagedMaterialUniformRefresh {
                            rows,
                            scene_content_key: content.scene_content_key(),
                        },
                    )));
                }
            }
            SceneInstanceDiff::ShadowFlagOnly {
                changed_indices,
                cast_changed: false,
            } => {
                // receive-shadow-only:词 31 = f(材质表面字段, receive)。
                // 材质表面字段(词 24..36 来源)由实例词守卫保证全同;材质
                // 资源(uniform 缓冲 + GpuMaterial)由 classify Identical 保证
                // 全同——本帧唯一的实例缓冲变化就是词 31 的接收阴影位。
                if geometries_equal
                    && textures_equal
                    && instance_material_words_unchanged(
                        &previous_packet.materials,
                        &packet.materials,
                    )
                    && let (Ok(previous_rows), Ok(next_rows)) = (
                        prepare_material_uniform_rows(previous_packet),
                        prepare_material_uniform_rows(packet),
                    )
                    && matches!(
                        classify_material_resources(&previous_rows, &next_rows),
                        MaterialResourceDiff::Identical
                    )
                {
                    let mut rows: Vec<(usize, f32)> = Vec::with_capacity(changed_indices.len());
                    for index in &changed_indices {
                        let instance = &packet.instances[*index as usize];
                        let Some(material_index) = packet
                            .materials
                            .iter()
                            .position(|material| material.id == instance.material)
                        else {
                            break;
                        };
                        rows.push((
                            *index as usize,
                            recompute_surface_flags(
                                &packet.materials[material_index],
                                instance.receive_shadow,
                            ),
                        ));
                    }
                    if rows.len() == changed_indices.len() {
                        return Ok(StagedRenderPacketUpdate::ShadowFlagRefresh(Box::new(
                            StagedShadowFlagRefresh {
                                rows,
                                scene_content_key: content.scene_content_key(),
                            },
                        )));
                    }
                }
            }
            SceneInstanceDiff::ShadowFlagOnly {
                cast_changed: true,
                ..
            }
            | SceneInstanceDiff::LodOnly { .. } => {
                // cast 阴影标志/LOD-only:参与批键,批可能重排 → 全实例重打包
                // 不可避免,但几何/纹理/材质与 LOD 不耦合(按 (id,revision) 版
                // 本键独立复用)——走资源复用刷新 staging(跳过纹理解码与整包
                // 内容哈希)。前置或查取失败回落全量路径;GPU 校验错误仍然
                // 原子拒绝。
                let materials_resources_equal = geometries_equal
                    && textures_equal
                    && match (
                        prepare_material_uniform_rows(previous_packet),
                        prepare_material_uniform_rows(packet),
                    ) {
                        (Ok(previous_rows), Ok(next_rows)) => matches!(
                            classify_material_resources(&previous_rows, &next_rows),
                            MaterialResourceDiff::Identical
                        ),
                        _ => false,
                    };
                if materials_resources_equal
                    && let Some(staged) = self
                        .try_stage_scene_refresh(
                            previous_packet,
                            packet,
                            content,
                            shadow_shader_key,
                            ibl,
                        )
                        .await?
                {
                    return Ok(staged);
                }
            }
            SceneInstanceDiff::Structural => {}
        }
        let shadow_relevance = classify_shadow_relevance(previous_packet, packet);
        let prepared = prepare_scene(packet)?;
        let culling = prepare_gpu_culling(packet, &prepared)?;
        let lod = prepare_gpu_lod(packet, &prepared)?;
        let pbr = prepare_pbr_resources(packet)?;
        let bounds = prepare_scene_bounds(packet)?;
        let shadow_casters = ShadowCasterSet::prepare(packet, &prepared, &culling, &lod)?;
        let shadow_update = self.shadow_map.stage_scene_update(
            &self.frame,
            shadow_camera(self.size, &self.frame, self.view),
            shadow_ray_direction(&self.frame),
            bounds,
        )?;
        let scene_update_ns =
            u64::try_from(prepare_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
        let staging_started = std::time::Instant::now();
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = self
            ._scene_cache
            .stage_scoped(
                &self.device,
                &self.queue,
                &self.material_layout,
                packet,
                content.scene_content_key(),
                &prepared,
                &pbr,
                content.resource_domain(),
            )
            .and_then(|mut scene| {
                scene.scene_mut().replace_shader_materials(
                    &self.device,
                    content,
                    &self.frame_buffer,
                    &self.shadow_map,
                    ibl,
                )?;
                let mut next_culling = GpuCulling::new(
                    &self.device,
                    &scene.scene().instance_buffer,
                    &culling,
                    &self.frame,
                    &shadow_update,
                    self.shadow_probe.is_some(),
                )?;
                // R4 生产接线:packet 更新会整体重建 GpuCulling,不重挂会把
                // 遮挡链静默丢掉(与 init/resize 同一挂载契约,开关关闭时跳过)。
                if let Some(pyramid) = &self.hi_z {
                    next_culling.attach_occlusion(
                        &self.device,
                        &scene.scene().instance_buffer,
                        pyramid.occlusion_source(),
                        &self.frame,
                        true,
                    )?;
                    next_culling.attach_occlusion_consume(
                        &self.device,
                        &scene.scene().instance_buffer,
                        false,
                    )?;
                }
                let next_lod = GpuLod::new(
                    &self.device,
                    &scene.scene().instance_buffer,
                    &lod,
                    &self.frame,
                    self.size,
                    &shadow_update,
                    self.view.near,
                )?;
                let shadow_keys = shadow_casters.keys(&shadow_update, shadow_shader_key)?;
                Ok((scene, next_culling, next_lod, shadow_keys))
            });
        let gpu_errors = [
            internal.pop().await,
            memory.pop().await,
            validation.pop().await,
        ];
        if let Some(error) = gpu_errors.into_iter().flatten().next() {
            drop(candidate);
            return Err(format!(
                "native RenderPacket candidate rejected atomically: {error}"
            ));
        }
        let (scene, culling, lod, shadow_keys) = candidate?;
        let resource_upload_ns =
            u64::try_from(staging_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
        Ok(StagedRenderPacketUpdate::Replace(Box::new(
            StagedRenderPacketPayload {
                scene,
                culling,
                lod,
                shadow_update,
                shadow_casters,
                shadow_keys,
                shadow_shader_key,
                invalidate_shadow: shadow_relevance.must_invalidate,
                scene_update_ns,
                resource_upload_ns,
                staged_via_resource_reuse: false,
            },
        )))
    }

    /// C3 切片三:资源复用的场景刷新 staging(cast 阴影标志 / LOD-only 变更)。
    /// 与全量 Replace 的唯一差别是跳过 `prepare_pbr_resources`(纹理解码)与
    /// `scene_resource_manifest`(整包内容哈希),按已提交清单版本键复用全部
    /// 已驻留 GPU 资源;prepare/contracts/阴影/批表/实例缓冲全部重建,产出与
    /// Replace 相同的 payload(publish 无分叉)。
    ///
    /// 返回 `Ok(None)` = 前置或驻留查取不成立,调用方回落全量路径;`Err` =
    /// GPU 校验错误,原子拒绝。错误域纪律:域内 Err 且域干净 → 回落;域报
    /// 错 → 拒绝。
    async fn try_stage_scene_refresh(
        &self,
        previous_packet: &deep_engine_native::contract::RenderPacket,
        packet: &deep_engine_native::contract::RenderPacket,
        content: &PlayerContent,
        shadow_shader_key: u64,
        ibl: &crate::gpu_ibl::GpuIblEnvironment,
    ) -> Result<Option<StagedRenderPacketUpdate>, String> {
        let domain = content.resource_domain();
        if self
            ._scene_cache
            .probe_scene_refresh(packet, domain)
            .is_err()
        {
            return Ok(None);
        }
        let prepare_started = std::time::Instant::now();
        let prepared = prepare_scene(packet)?;
        let culling = prepare_gpu_culling(packet, &prepared)?;
        let lod = prepare_gpu_lod(packet, &prepared)?;
        let bounds = prepare_scene_bounds(packet)?;
        let shadow_casters = ShadowCasterSet::prepare(packet, &prepared, &culling, &lod)?;
        let shadow_update = self.shadow_map.stage_scene_update(
            &self.frame,
            shadow_camera(self.size, &self.frame, self.view),
            shadow_ray_direction(&self.frame),
            bounds,
        )?;
        let shadow_relevance = classify_shadow_relevance(previous_packet, packet);
        let scene_update_ns =
            u64::try_from(prepare_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
        let staging_started = std::time::Instant::now();
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = self
            ._scene_cache
            .stage_scene_refresh(
                &self.device,
                &self.queue,
                packet,
                content.scene_content_key(),
                &prepared,
                self.scene.pbr_summary(),
                domain,
            )
            .and_then(|mut scene| {
                scene.scene_mut().replace_shader_materials(
                    &self.device,
                    content,
                    &self.frame_buffer,
                    &self.shadow_map,
                    ibl,
                )?;
                let mut next_culling = GpuCulling::new(
                    &self.device,
                    &scene.scene().instance_buffer,
                    &culling,
                    &self.frame,
                    &shadow_update,
                    self.shadow_probe.is_some(),
                )?;
                // 与 Replace 同一挂载契约:packet 更新重建 GpuCulling,不重挂
                // 会把遮挡链静默丢掉(开关关闭时跳过)。
                if let Some(pyramid) = &self.hi_z {
                    next_culling.attach_occlusion(
                        &self.device,
                        &scene.scene().instance_buffer,
                        pyramid.occlusion_source(),
                        &self.frame,
                        true,
                    )?;
                    next_culling.attach_occlusion_consume(
                        &self.device,
                        &scene.scene().instance_buffer,
                        false,
                    )?;
                }
                let next_lod = GpuLod::new(
                    &self.device,
                    &scene.scene().instance_buffer,
                    &lod,
                    &self.frame,
                    self.size,
                    &shadow_update,
                    self.view.near,
                )?;
                let shadow_keys =
                    shadow_casters.keys(&shadow_update, shadow_shader_key)?;
                Ok((scene, next_culling, next_lod, shadow_keys))
            });
        let gpu_errors = [
            internal.pop().await,
            memory.pop().await,
            validation.pop().await,
        ];
        if let Some(error) = gpu_errors.into_iter().flatten().next() {
            drop(candidate);
            return Err(format!(
                "native RenderPacket refresh candidate rejected atomically: {error}"
            ));
        }
        // 域干净但查取失活(驱逐/释放)→ 回落全量路径,由全量 staging 重建
        // 版本登记;这里不产生部分副作用(候选被丢弃,无 commit)。
        let Ok((scene, culling, lod, shadow_keys)) = candidate else {
            return Ok(None);
        };
        let resource_upload_ns =
            u64::try_from(staging_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
        Ok(Some(StagedRenderPacketUpdate::Replace(Box::new(
            StagedRenderPacketPayload {
                scene,
                culling,
                lod,
                shadow_update,
                shadow_casters,
                shadow_keys,
                shadow_shader_key,
                invalidate_shadow: shadow_relevance.must_invalidate,
                scene_update_ns,
                resource_upload_ns,
                staged_via_resource_reuse: true,
            },
        ))))
    }

    pub(crate) fn publish_render_packet_update(
        &mut self,
        staged: StagedRenderPacketUpdate,
    ) -> Result<GpuSceneCacheMetrics, String> {
        if let StagedRenderPacketUpdate::MaterialUniformRefresh(staged) = &staged {
            let upload_started = std::time::Instant::now();
            self.scene
                .pbr
                .write_material_uniforms(&self.queue, &staged.rows)?;
            let resource_upload_ns =
                u64::try_from(upload_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
            self.scene.set_scene_content_key(staged.scene_content_key);
            // 材质数值变化影响表面在光照/阴影下的呈现,保守失效阴影缓存
            // (与 TransformRefresh 同级;不做逐材质阴影相关性分析)。
            self.shadow_version.bump_scene();
            // R6-2/C3 遥测:快路径无全量场景准备,scene_update 记 0,honest。
            if let Some(telemetry) = self.telemetry.as_mut() {
                telemetry.record_packet_prepare(0, resource_upload_ns);
            }
            return Ok(GpuSceneCacheMetrics::default());
        }
        if let StagedRenderPacketUpdate::ShadowFlagRefresh(staged) = &staged {
            let upload_started = std::time::Instant::now();
            self.scene
                .write_instance_shadow_flags(&self.queue, &staged.rows)?;
            let resource_upload_ns =
                u64::try_from(upload_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
            self.scene.set_scene_content_key(staged.scene_content_key);
            // receive_shadow 只改 lit-pass 采样语义(实例词 31);caster 集合、
            // 批布局与阴影贴图全部不变——不失效阴影版本(与
            // classify_shadow_relevance 对"实例集未变"的判定一致)。
            // R6-2/C3 遥测:快路径无全量场景准备,scene_update 记 0,honest。
            if let Some(telemetry) = self.telemetry.as_mut() {
                telemetry.record_packet_prepare(0, resource_upload_ns);
            }
            return Ok(GpuSceneCacheMetrics::default());
        }
        if let StagedRenderPacketUpdate::TransformRefresh(staged) = &staged {
            let upload_started = std::time::Instant::now();
            self.scene
                .write_instance_transforms(&self.queue, &staged.rows)?;
            let resource_upload_ns =
                u64::try_from(upload_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
            self.scene.set_scene_content_key(staged.scene_content_key);
            // 变换变化 = 阴影投影变化,保守失效阴影缓存(与 Replace 的 must_invalidate 同级)。
            self.shadow_version.bump_scene();
            // R6-2 遥测:快路径无全量场景准备,scene_update 记 0,honest。
            if let Some(telemetry) = self.telemetry.as_mut() {
                telemetry.record_packet_prepare(0, resource_upload_ns);
            }
            return Ok(GpuSceneCacheMetrics::default());
        }
        let StagedRenderPacketUpdate::Replace(staged) = staged else {
            return Ok(GpuSceneCacheMetrics::default());
        };
        let metrics = staged.scene.metrics();
        let scene = self._scene_cache.commit(staged.scene)?;
        self.shadow_map
            .publish_scene_update(&self.queue, staged.shadow_update);
        self.scene = scene;
        self.culling = staged.culling;
        self.lod = staged.lod;
        self.shadow_casters = staged.shadow_casters;
        self.shadow_keys = staged.shadow_keys;
        self.shadow_shader_key = staged.shadow_shader_key;
        if staged.invalidate_shadow {
            self.shadow_version.bump_scene();
        }
        // R6-2 细分:commit 成功后记入 packet 级准备样本(唯一提交点,
        // 覆盖 replace_render_packet / present_render_packet_update /
        // drop_preview 三条汇入路径)。
        if let Some(telemetry) = self.telemetry.as_mut() {
            telemetry.record_packet_prepare(staged.scene_update_ns, staged.resource_upload_ns);
        }
        Ok(metrics)
    }
}
