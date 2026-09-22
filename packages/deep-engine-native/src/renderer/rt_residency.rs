//! Renderer 侧硬件 RT 驻留(F2 最小切片):静态 opaque/MASK 实例的 BLAS 缓存
//! + 场景 TLAS + frame bind group 的 AccelerationStructure 槽。
//!
//! 诚实边界:本切片只做驻留与绑定,不做像素消费。诊断始终保持 degraded
//! (`tlas_resident_pixel_pending`),正式阴影/反射/GI 的 RT 着色由后续切片接入;
//! 栅格主通路不被本模块阻塞——任何拒绝都 fail-closed 关闭 RT 并记录原因。

use deep_engine_native::contract::AlphaMode;
use deep_engine_native::hardware_ray_query::{
    HardwareRayError, ResidentBlasGeometry, build_resident_blas_set, build_tlas_from_blas,
};

use super::Renderer;
use crate::gpu_scene::GpuScene;

/// 与 Web RayBackend 合同 `RAY_BACKEND_LIMITS` 对齐
/// (packages/deep-engine/src/rayTracing/rayBackendTypes.ts):单 BLAS 三角预算。
pub(crate) const RT_MAX_BLAS_TRIANGLES: u64 = 4_194_304;
/// 同上:TLAS 实例数预算。
pub(crate) const RT_MAX_INSTANCES: u64 = 262_144;
/// GI 射线掩码,与 Web `RENDER_PACKET_GI_RAY_MASK` 同值;语义由消费者定义。
pub(crate) const RT_SCENE_RAY_MASK: u8 = 1;

/// 驻留拒绝原因。全部 fail-closed:只关闭 RT,不触碰栅格主通路。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RtResidencyReject {
    /// 选定 device 未启用 EXPERIMENTAL_RAY_QUERY(维持既有诊断原因不变)。
    MissingFeature,
    /// 分类后没有可驻留实例(空场景或全部 BLEND)。
    EmptyScene,
    /// 超出 Web RayBackend 同源预算(实例数/单几何三角形)。
    BudgetExceeded,
    /// 几何流不满足 BLAS 输入合同(非三角索引等,已被上游校验拦下)。
    GeometryInvalid,
}

impl RtResidencyReject {
    /// PlayerDiagnostics 的 `hardware_ray_query` 原因字符串(静态,机器可读)。
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::MissingFeature => "adapter_feature_unavailable",
            Self::EmptyScene => "tlas_no_resident_instances",
            Self::BudgetExceeded => "tlas_budget_exceeded",
            Self::GeometryInvalid => "tlas_geometry_rejected",
        }
    }
}

impl From<HardwareRayError> for RtResidencyReject {
    fn from(error: HardwareRayError) -> Self {
        match error {
            HardwareRayError::MissingFeature => Self::MissingFeature,
            HardwareRayError::InvalidGeometry => Self::GeometryInvalid,
        }
    }
}

/// 计划出的一个 BLAS:按首次使用的实例顺序去重后的几何。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RtPlannedGeometry {
    pub geometry_index: usize,
    pub vertex_count: u32,
    pub index_count: u32,
}

/// 计划出的一个 TLAS 实例。`transform` 是行主序 3x4 模型矩阵
/// (GpuScene packed 行词 0..12 的原布局),`custom_index` 是打包实例行号,
/// 供未来像素消费者回查材质。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RtPlannedInstance {
    pub blas_slot: u32,
    pub transform: [f32; 12],
    pub custom_index: u32,
}
/// 纯计划核输出:去重与预算判定全部在此完成,不触碰 device,因此
/// 预算 fail-closed 与 BLAS 复用语义可脱离 GPU 单测钉死。BLEND/MASK 的
/// 分类计数由 `plan_gpu_scene` 以批次 alpha 模式完成。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RtScenePlan {
    pub geometries: Vec<RtPlannedGeometry>,
    pub instances: Vec<RtPlannedInstance>,
    /// BLEND 整族排除:最近命中 ABI 没有 any-hit alpha continuation
    /// (Web renderPacketRayScene 同口径)。
    pub excluded_blend_instances: u32,
    /// MASK 保守包含:GI 核暂不采样纹理 alpha,当作 opaque 参与。
    pub conservative_mask_instances: u32,
    /// 引用零三角几何的实例:无 BLAS 可驻留,一并排除并计数。
    pub excluded_empty_geometry_instances: u32,
    pub triangles: u64,
}

/// 纯计划核。`geometries` 按 GpuScene 几何序给出 (vertex_count, index_count);
/// `instances` 给出 (geometry_index, 打包实例行号, 行主序 3x4 变换)。
/// 只有已决定驻留的实例(opaque/MASK)会进入本核。
pub(crate) fn plan_rt_scene(
    geometries: &[(u32, u32)],
    instances: &[(usize, u32, [f32; 12])],
) -> Result<RtScenePlan, RtResidencyReject> {
    let mut plan = RtScenePlan {
        geometries: Vec::new(),
        instances: Vec::with_capacity(instances.len()),
        excluded_blend_instances: 0,
        conservative_mask_instances: 0,
        excluded_empty_geometry_instances: 0,
        triangles: 0,
    };
    let mut blas_slots: Vec<Option<u32>> = vec![None; geometries.len()];
    for &(geometry_index, packed_row, transform) in instances {
        let Some(&(vertex_count, index_count)) = geometries.get(geometry_index) else {
            return Err(RtResidencyReject::GeometryInvalid);
        };
        let triangles = u64::from(index_count) / 3;
        if index_count == 0 || vertex_count == 0 {
            plan.excluded_empty_geometry_instances += 1;
            continue;
        }
        let slot = match blas_slots[geometry_index] {
            Some(slot) => slot,
            None => {
                // 同一几何只建一次 BLAS;预算按单几何三角形计,超限整体拒绝。
                if triangles > RT_MAX_BLAS_TRIANGLES {
                    return Err(RtResidencyReject::BudgetExceeded);
                }
                let slot = plan.geometries.len() as u32;
                blas_slots[geometry_index] = Some(slot);
                plan.geometries.push(RtPlannedGeometry {
                    geometry_index,
                    vertex_count,
                    index_count,
                });
                plan.triangles += triangles;
                slot
            }
        };
        plan.instances.push(RtPlannedInstance {
            blas_slot: slot,
            transform,
            custom_index: packed_row,
        });
    }
    if u64::try_from(plan.instances.len()).unwrap_or(u64::MAX) > RT_MAX_INSTANCES {
        return Err(RtResidencyReject::BudgetExceeded);
    }
    if plan.instances.is_empty() {
        return Err(RtResidencyReject::EmptyScene);
    }
    Ok(plan)
}

/// GpuScene 适配:批次给出 alpha 模式与实例区间,packed 行词 0..12 直接
/// 充当行主序 3x4 TLAS 实例变换(scene::recompute_transform_update 布局)。
pub(crate) fn plan_gpu_scene(scene: &GpuScene) -> Result<RtScenePlan, RtResidencyReject> {
    let geometries: Vec<(u32, u32)> = scene
        .geometries
        .iter()
        .map(|geometry| (geometry.vertex_count, geometry.index_count))
        .collect();
    let (classified, excluded_blend, conservative_mask) =
        classify_rt_batches(&scene.batches, scene.packed_instances());
    let mut plan = plan_rt_scene(&geometries, &classified)?;
    plan.excluded_blend_instances = excluded_blend;
    plan.conservative_mask_instances = conservative_mask;
    Ok(plan)
}

/// 纯批次分类:BLEND 整批排除、MASK 保守计入(opaque 同路),返回
/// (驻留候选实例, BLEND 排除数, MASK 保守包含数)。与 GpuScene 解耦,
/// 便于脱离 device 单测钉死口径。
pub(crate) fn classify_rt_batches(
    batches: &[deep_engine_native::scene::DrawBatch],
    packed: &[deep_engine_native::scene::PackedInstance],
) -> (Vec<(usize, u32, [f32; 12])>, u32, u32) {
    let mut classified = Vec::new();
    let mut excluded_blend = 0u32;
    let mut conservative_mask = 0u32;
    for batch in batches {
        let start = batch.instance_start as usize;
        let end = start + batch.instance_count as usize;
        let rows = packed[start..end]
            .iter()
            .enumerate()
            .map(|(offset, row)| {
                (
                    batch.geometry_index,
                    (start + offset) as u32,
                    row[..12]
                        .try_into()
                        .expect("packed row carries a 3x4 model"),
                )
            })
            .collect::<Vec<(usize, u32, [f32; 12])>>();
        match batch.alpha_mode {
            // BLEND 排除口径与 Web renderPacketRayScene 一致:整批跳过。
            AlphaMode::Blend => excluded_blend += batch.instance_count,
            // MASK 保守包含:与 opaque 同路驻留,单独计数供诊断。
            AlphaMode::Mask => {
                conservative_mask += batch.instance_count;
                classified.extend(rows);
            }
            AlphaMode::Opaque => classified.extend(rows),
        }
    }
    (classified, excluded_blend, conservative_mask)
}

/// 驻留产物:BLAS 缓存(几何变更才重建)+ 场景 TLAS(变换变更只重建它)
/// + F2 pixel 管线族(opaque/MASK 方向阴影 Ray Query 变体,与驻留同依赖
/// 设备 RT 特性,故随驻留同生命周期搬运;场景替换重建驻留时原样迁移)。
#[allow(dead_code)] // plan 字段经 plan()/rebuild_tlas 被 tests 与诊断消费。
pub(crate) struct RtSceneResidency {
    tlas: wgpu::Tlas,
    blas: Vec<wgpu::Blas>,
    plan: RtScenePlan,
    /// F2 pixel:opaque/MASK 方向阴影 Ray Query 管线族。仅设备启用 ray
    /// query 且管线创建成功时存在;缺失时 opaque pass 回退栅格管线。
    pixel_pipelines: Option<crate::pipeline::RtMeshPipelines>,
}

impl RtSceneResidency {
    /// 从已驻留的 GpuGeometry 缓冲构建 BLAS 集 + 场景 TLAS。
    /// 返回的两个 encoder 必须按序提交(先 BLAS 后 TLAS),TLAS 随后即可绑定。
    pub(crate) fn build(
        device: &wgpu::Device,
        scene: &GpuScene,
    ) -> Result<(Self, wgpu::CommandEncoder, wgpu::CommandEncoder), RtResidencyReject> {
        if !device
            .features()
            .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
        {
            return Err(RtResidencyReject::MissingFeature);
        }
        let plan = plan_gpu_scene(scene)?;
        let blas_geometries: Vec<ResidentBlasGeometry> = plan
            .geometries
            .iter()
            .map(|planned| {
                let geometry = &scene.geometries[planned.geometry_index];
                ResidentBlasGeometry {
                    vertex_buffer: &geometry.vertex_buffer,
                    index_buffer: &geometry.index_buffer,
                    vertex_count: planned.vertex_count,
                    index_count: planned.index_count,
                }
            })
            .collect();
        let (blas, blas_encoder) =
            build_resident_blas_set(device, &blas_geometries).map_err(RtResidencyReject::from)?;
        let instances: Vec<(&wgpu::Blas, [f32; 12], u32, u8)> = plan
            .instances
            .iter()
            .map(|instance| {
                (
                    &blas[instance.blas_slot as usize],
                    instance.transform,
                    instance.custom_index,
                    RT_SCENE_RAY_MASK,
                )
            })
            .collect();
        let (tlas, tlas_encoder) =
            build_tlas_from_blas(device, &instances).map_err(RtResidencyReject::from)?;
        Ok((
            Self {
                tlas,
                blas,
                plan,
                pixel_pipelines: None,
            },
            blas_encoder,
            tlas_encoder,
        ))
    }

    /// transform-only TLAS 重建:BLAS 缓存原样复用(同几何不重建),仅按新
    /// 变换重建 TLAS。`transforms` 必须与计划实例同长同序。本切片的栅格
    /// 帧循环尚无消费者(transform 更新走场景替换→整体重建);接口与测试
    /// 先钉死合同,细粒度接线待几何内容键复用切片。
    #[allow(dead_code)] // 消费方为 rt_residency_tests(GPU 定向测试)。
    pub(crate) fn rebuild_tlas(
        &mut self,
        device: &wgpu::Device,
        transforms: &[[f32; 12]],
    ) -> Result<wgpu::CommandEncoder, RtResidencyReject> {
        if transforms.len() != self.plan.instances.len() {
            return Err(RtResidencyReject::GeometryInvalid);
        }
        let instances: Vec<(&wgpu::Blas, [f32; 12], u32, u8)> = self
            .plan
            .instances
            .iter()
            .zip(transforms)
            .map(|(instance, transform)| {
                (
                    &self.blas[instance.blas_slot as usize],
                    *transform,
                    instance.custom_index,
                    RT_SCENE_RAY_MASK,
                )
            })
            .collect();
        let (tlas, encoder) =
            build_tlas_from_blas(device, &instances).map_err(RtResidencyReject::from)?;
        self.tlas = tlas;
        Ok(encoder)
    }

    pub(crate) fn tlas(&self) -> &wgpu::Tlas {
        &self.tlas
    }

    /// 计划快照:诊断与测试消费(排除/保守计数)。
    #[allow(dead_code)] // 消费方为 rt_residency_tests 与后续诊断细分。
    pub(crate) fn plan(&self) -> &RtScenePlan {
        &self.plan
    }

    /// BLAS 缓存大小:同几何共享一份,测试钉死"同几何不重建"。
    #[allow(dead_code)]
    pub(crate) fn blas_count(&self) -> usize {
        self.blas.len()
    }

    /// F2 pixel 管线族访问:opaque pass 分支据此决定是否走 RT 管线。
    pub(crate) fn pixel_pipelines(&self) -> Option<&crate::pipeline::RtMeshPipelines> {
        self.pixel_pipelines.as_ref()
    }

    /// init 在栅格原子事务之外创建 RT 管线族后注入;场景替换重建驻留时
    /// 由 reestimate 原样迁移(管线族只依赖 device,不依赖场景内容)。
    pub(super) fn install_pixel_pipelines(
        &mut self,
        pipelines: crate::pipeline::RtMeshPipelines,
    ) {
        self.pixel_pipelines = Some(pipelines);
    }

    /// init 的 error scope 捕获到管线族创建错误后丢弃(可能含 invalid
    /// 资源),opaque pass 据此回退栅格。
    pub(super) fn drop_pixel_pipelines(&mut self) {
        self.pixel_pipelines = None;
    }
}

impl Renderer {
    /// 用当前场景重建 RT 驻留(初始化与场景整体替换共用)。任何失败都
    /// fail-closed:RT 关闭、frame RT 槽卸下、诊断记录原因,绝不阻塞栅格
    /// 主通路。成功则同步重建 frame RT 绑定(引用 IBL 纹理与 TLAS)。
    pub(super) fn reestablish_rt_residency(&mut self) {
        // F2 pixel 管线族只依赖 device 能力,不依赖场景内容;跨驻留重建
        // 先 take 出来原样装回,重建失败时随旧驻留一起关闭(fail-closed)。
        let pixel_pipelines = self
            .rt_residency
            .as_mut()
            .and_then(|residency| residency.pixel_pipelines.take());
        self.rt_residency = None;
        self.rt_frame_bind_group = None;
        match RtSceneResidency::build(&self.device, &self.scene) {
            Ok((mut residency, blas_encoder, tlas_encoder)) => {
                // BLAS 必须先于 TLAS 完成;单次 submit 内 FIFO 保证执行序。
                self.queue
                    .submit([blas_encoder.finish(), tlas_encoder.finish()]);
                self.rt_frame_bind_group = self.rt_frame_bind_group_resource(&residency);
                residency.pixel_pipelines = pixel_pipelines;
                self.diagnostics.note_rt_tlas_resident();
                // F2 pixel:管线族迁移成功且场景无 custom shader 批次时,
                // 诊断升级为真实像素消费态;否则保持驻留态(含 custom
                // shader 场景——其批次只能用普通 frame 绑定,整帧回退栅格)。
                if residency.pixel_pipelines.is_some() && self.scene.shader_materials.is_none() {
                    self.diagnostics.note_rt_directional_shadow_pixels();
                }
                self.rt_residency = Some(residency);
            }
            Err(RtResidencyReject::MissingFeature) => {
                // 能力缺失时维持诊断既有的 adapter/device 精确原因,不覆盖。
            }
            Err(reject) => self.diagnostics.note_rt_tlas_rejected(reject.reason()),
        }
    }

    /// frame RT 槽绑定:仅在驻留与 RT 扩展 layout 同时就绪时存在。
    fn rt_frame_bind_group_resource(
        &self,
        residency: &RtSceneResidency,
    ) -> Option<wgpu::BindGroup> {
        let layout = self.rt_frame_layout.as_ref()?;
        Some(self.ibl.create_rt_frame_bind_group(
            &self.device,
            layout,
            &self.frame_buffer,
            Some(&self.ies_buffer),
            &self.shadow_map,
            residency.tlas(),
            Some(&self.probe_frame_buffer),
            "Deep Engine native RT frame bindings",
        ))
    }
}
