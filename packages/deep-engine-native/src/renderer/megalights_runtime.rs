//! P1 质量主线:megaLights RIS 生产帧接线(统一灯池 → 决策 → 档位供给)。
//!
//! 把已入库的 MegaLights 链([`deep_engine_native::megalights_abi`] 64B 灯池 +
//! [`deep_engine_native::megalights_ris`] 直射通路决策/蓄水池 +
//! [`deep_engine_native::megalights_ies`] IES 因子 +
//! [`deep_engine_native::megalights_visibility`] 胜者可见性)接进渲染器帧循环:
//! 每帧刷新直射通路决策(`resolve_direct_lighting_path`,native 簇预算 16 =
//! `MAX_LOCAL_LIGHTS`)、把作者局部灯(点/聚)变换到视空间并打包统一灯池、
//! IES 档位做 light-slot → spot-ordinal 行重映射、可见性档位按 TLAS 驻留
//! 可用性 fail-closed 披露——TS `megaLightsFrameDecision.ts`/`megaLightsRuntime.ts`
//! 的帧上下文合同(dispatched/reason/visibilitySource)同构。
//!
//! == 门控(fail-closed)==
//! `DEEP_ENGINE_NATIVE_MEGALIGHTS`(缺省 off;`auto` = 纯预算阈值决策,`force` =
//! 显式 RIS)。关闭 = 零构造零帧成本,既有簇光路径逐位不变。运行时存在后,
//! 决策回落簇光(未强制且 ≤ 预算)同样零回归——灯池/IES/可见性只是驻留供给。
//!
//! == 执行腿(2026-10-07 GPU dispatch 生产化)==
//! RIS consumes actual opaque material/depth and winner TLAS visibility.
//! It replaces opaque local lighting and retains the transparent MSAA resolve.
//! Resources are created at the first RIS frame; rejected profiles retain clusters.
//! 门关/auto-预算内帧零 dispatch 零字节变化。

#[path = "megalights_runtime_gpu.rs"] mod gpu;
#[path = "megalights_runtime_lights.rs"] mod lights;
use lights::{count_pool_lights, build_view_space_pool, remap_ies_spot_rows};
pub(crate) use lights::to_view;
use deep_engine_native::local_lighting::{LocalLight, LocalLightKind, MAX_LOCAL_LIGHTS};
use deep_engine_native::megalights_abi::{
    MegaLight, MegaLightKind, PackedMegaLights, pack_mega_lights,
};
use deep_engine_native::megalights_ies::MegaLightsIesPacking;
use deep_engine_native::megalights_ris::{
    DirectLightingPath, DirectLightingPathDecision, resolve_direct_lighting_path,
};
use deep_engine_native::player_view::PlayerView;
use deep_engine_native::scene_lighting::DirectionalLighting;

/// 门控词汇(缺省/未知值 = off,fail-closed)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MegaLightsGate {
    Off,
    /// 预算阈值决策(灯数 > 簇预算才走 RIS;native 局部灯 ≤16 恒簇光)。
    Auto,
    /// 显式强制 RIS(退化对拍/验收⑤ 同语义;灯数不限)。
    Force,
}

pub(crate) fn megalights_gate() -> MegaLightsGate {
    parse_megalights_gate(
        std::env::var("DEEP_ENGINE_NATIVE_MEGALIGHTS")
            .ok()
            .as_deref(),
    )
}

fn parse_megalights_gate(value: Option<&str>) -> MegaLightsGate {
    match value.map(|raw| raw.trim().to_ascii_lowercase()).as_deref() {
        Some("auto") => MegaLightsGate::Auto,
        Some("1" | "on" | "true" | "force" | "enabled") => MegaLightsGate::Force,
        _ => MegaLightsGate::Off,
    }
}

/// RIS 求值执行腿状态(词汇封闭;真机门已过,状态随 GPU 链挂载结果如实推进)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MegaLightsExecutionLeg {
    /// 执行腿待命(门开但 GPU 链未挂载:auto 预算内恒簇光,链在首个 RIS
    /// 决策帧懒构造;真机门已过,挂载即驻留)。
    ColdStandby,
    /// GPU 生产链驻留:表面重建 + RIS 两趟 + 加性合成,首个 RIS 决策帧起
    /// 帧内 dispatch(TS 生产合同同构;真机三腿已验)。
    GpuDispatchResident,
    /// GPU 资源面被设备拒/超限(fail-closed;视觉恒走既有簇光,原因经诊断披露)。
    GpuDegraded,
}

/// 胜者可见性档位供给状态(TS `visibilitySource` 词汇同构)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MegaLightsVisibilitySource {
    /// 场景 TLAS 驻留在场(RT 驻留构建成功);可见性档位可供给。
    TlasResident,
    /// 无 TLAS;生产 RIS 保留完整簇光。
    Off,
}

/// megaLights 帧运行时(门开 + 内容有局部灯才构造;Renderer 独占)。
/// 字段 crate 内可见(renderer 测试域消费)。
pub(crate) struct MegaLightsFrameRuntime {
    gate: MegaLightsGate,
    execution_leg: MegaLightsExecutionLeg,
    /// 统一灯池(视空间;每帧自作者局部灯重建,≤16 盏成本可忽略)。
    pub(crate) pool: Vec<MegaLight>,
    /// 灯池打包结果(64B/灯 ABI;执行腿激活即上传,本切片仅驻留)。
    pub(crate) packed: Option<PackedMegaLights>,
    /// IES 档位:spot-ordinal 行重映射载荷(spot 参数节 + 表节拷贝;None =
    /// 无 IES spot 或行重映射 fail-closed 回退,因子恒 1)。
    pub(crate) ies: Option<(Vec<f32>, usize)>,
    /// 上一帧决策(帧间披露)。
    pub(crate) decision: DirectLightingPathDecision,
    pub(crate) visibility_source: MegaLightsVisibilitySource,
    pub(crate) frame_index: u32,
    /// GPU 执行腿链(首个 RIS 决策帧懒构造;None = 待命或已降级)。
    pub(crate) gpu: Option<super::megalights_gpu::MegaLightsGpuChain>,
    /// GPU 腿已 dispatch 帧数(遥测/证据链)。
    gpu_dispatched_frames: u32,
    /// 首挂载视口注入(frame.rs 每帧写入前向前向尺寸)。
    pending_viewport: (u32, u32),
    /// 最近一次挂载失败拒因(sticky;诊断披露)。
    pub(crate) gpu_reject_reason: Option<&'static str>,
    pub(super) gbuffer: Option<super::megalights_gbuffer::MegaLightsGBuffer>,
    history_valid: bool,
    last_view: Option<PlayerView>,
    shadow_mask: u32,
    last_scene_key: Option<u64>,
}

impl MegaLightsFrameRuntime {
    /// 构建:门控词汇 + IES 行重映射(初判决策;逐帧重算)。
    /// `ies_storage_rows` = 既有 `NativeIesShadingResource` 行(16 灯槽参数节 +
    /// profile 元数据节 + 展开表);本构造只读引用,不做表展开。
    pub(crate) fn build(
        lighting: &DirectionalLighting,
        gate: MegaLightsGate,
        ies_storage_rows: Option<&[[f32; 4]]>,
        tlas_resident: bool,
    ) -> Self {
        let ies = remap_ies_spot_rows(lighting, ies_storage_rows);
        let forced = gate == MegaLightsGate::Force;
        let (points, spots) = count_pool_lights(lighting);
        let decision =
            resolve_direct_lighting_path(points, spots, 0, forced, Some(MAX_LOCAL_LIGHTS));
        Self {
            gate,
            execution_leg: MegaLightsExecutionLeg::ColdStandby,
            pool: Vec::new(),
            packed: None,
            ies,
            decision,
            visibility_source: if tlas_resident {
                MegaLightsVisibilitySource::TlasResident
            } else {
                MegaLightsVisibilitySource::Off
            },
            frame_index: 0,
            gpu: None,
            gpu_dispatched_frames: 0,
            pending_viewport: (0, 0),
            gpu_reject_reason: None,
            gbuffer: None,
            history_valid: false,
            last_view: None,
            shadow_mask: 0,
            last_scene_key: None,
        }
    }

    /// 帧推进:重算决策 + 重建视空间灯池(含 IES 行号) + 刷新可见性档位
    /// 可用性。确定性:无 RNG,同输入逐位同输出;执行腿未激活,视觉零影响。
    pub(crate) fn advance(
        &mut self,
        view: PlayerView,
        lighting: Option<&DirectionalLighting>,
        tlas_resident: bool,
    ) {
        let Some(lighting) = lighting else {
            return;
        };
        let forced = self.gate == MegaLightsGate::Force;
        let (points, spots) = count_pool_lights(lighting);
        self.decision =
            resolve_direct_lighting_path(points, spots, 0, forced, Some(MAX_LOCAL_LIGHTS));
        self.pool = build_view_space_pool(lighting, view, self.ies_spot_ordinals());
        let packed = (!self.pool.is_empty()).then(|| pack_mega_lights(&self.pool));
        if self.last_view != Some(view) || self.packed.as_ref().map(|p| &p.data) != packed.as_ref().map(|p| &p.data) {
            self.history_valid = false;
        }
        let shadow_mask = lighting.local_lights.iter().filter(|light|
            matches!(light.kind, LocalLightKind::Point | LocalLightKind::Spot)).enumerate()
            .fold(0, |mask, (i, light)| mask | (u32::from(light.cast_shadow) << i));
        if self.shadow_mask != shadow_mask { self.history_valid = false; }
        self.shadow_mask = shadow_mask;
        self.last_view = Some(view);
        self.packed = packed;
        self.visibility_source = if tlas_resident {
            MegaLightsVisibilitySource::TlasResident
        } else {
            MegaLightsVisibilitySource::Off
        };
        self.frame_index = self.frame_index.wrapping_add(1);
    }

    pub(crate) fn note_scene_content(&mut self, key: u64) {
        if self.last_scene_key != Some(key) { self.history_valid = false; }
        self.last_scene_key = Some(key);
    }

    /// IES 档位在灯池内的行号视图(重映射载荷的 spot 序;None = 恒 1)。
    pub(crate) fn ies_packing(&self) -> Option<MegaLightsIesPacking<'_>> {
        let (words, spot_count) = self.ies.as_ref()?;
        Some(MegaLightsIesPacking::new(words, *spot_count))
    }

    /// 挂载前的视口注入(frame.rs 每帧写入前向前向尺寸;首挂载尺寸来源)。
    pub(crate) fn note_pending_viewport(&mut self, width: u32, height: u32) {
        self.pending_viewport = (width, height);
    }

    /// 最近一次挂载失败拒因(诊断披露;None = 未降级)。
    pub(crate) fn telemetry_gpu_reject_reason(&self) -> Option<&'static str> {
        self.gpu_reject_reason
    }

    fn ies_spot_ordinals(&self) -> bool {
        self.ies.is_some()
    }

    /// 诊断面(帧间披露;遥测与验收证据链)。
    pub(crate) fn telemetry(&self) -> MegaLightsTelemetry {
        MegaLightsTelemetry {
            gate: self.gate,
            execution_leg: self.execution_leg,
            decision: self.decision,
            pool_count: self.pool.len(),
            ies_spot_count: self.ies.as_ref().map_or(0, |(_, count)| *count),
            visibility_source: self.visibility_source,
            frame_index: self.frame_index,
            gpu_dispatched_frames: self.gpu_dispatched_frames,
        }
    }
}

/// 帧遥测快照(词面与 TS FrameMetrics.megaLights 同构;GPU 腿字段为 native 扩展)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MegaLightsTelemetry {
    pub gate: MegaLightsGate,
    pub execution_leg: MegaLightsExecutionLeg,
    pub decision: DirectLightingPathDecision,
    pub pool_count: usize,
    pub ies_spot_count: usize,
    pub visibility_source: MegaLightsVisibilitySource,
    pub frame_index: u32,
    /// GPU 执行腿已 dispatch 帧数(0 = 执行腿未激活/未到 RIS 帧)。
    pub gpu_dispatched_frames: u32,
}

#[cfg(test)]
#[path = "megalights_runtime_tests.rs"]
mod megalights_runtime_tests;
