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
//! == 执行腿(如实)==
//! RIS 求值执行腿 = GPU RIS 核 dispatch(`megaLightsRis.wgsl`),在 wgpu 30
//! naga 编译路径有已知执行限制且真机复验未做(见 megalights_gpu_probe_tests)。
//! 本切片接线 = 决策 + 灯池/IES/可见性驻留供给,执行腿状态如实为
//! [`MegaLightsExecutionLeg::PendingRealMachineGate`];GBuffer 表面供给与
//! 像素消费 pass 为后继切片,绝不虚报生产能力。现役直射恒走既有簇光。

use deep_engine_native::local_lighting::{LocalLight, LocalLightKind, MAX_LOCAL_LIGHTS};
use deep_engine_native::megalights_abi::{
    MegaLight, MegaLightKind, PackedMegaLights, pack_mega_lights,
};
use deep_engine_native::megalights_ies::MegaLightsIesPacking;
use deep_engine_native::megalights_ris::{
    DirectLightingPathDecision, resolve_direct_lighting_path,
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

/// RIS 求值执行腿状态(词汇封闭;本切片恒 PendingRealMachineGate)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MegaLightsExecutionLeg {
    /// GPU RIS 核 dispatch 待真机门复验(wgpu 30 naga 已知限制);帧内视觉
    /// 恒走既有簇光路径。
    PendingRealMachineGate,
}

/// 胜者可见性档位供给状态(TS `visibilitySource` 词汇同构)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MegaLightsVisibilitySource {
    /// 场景 TLAS 驻留在场(RT 驻留构建成功);可见性档位可供给。
    TlasResident,
    /// 无 TLAS(fail-closed);可见性恒 1 = M1 旧行为。
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
            execution_leg: MegaLightsExecutionLeg::PendingRealMachineGate,
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
        self.packed = (!self.pool.is_empty()).then(|| pack_mega_lights(&self.pool));
        self.visibility_source = if tlas_resident {
            MegaLightsVisibilitySource::TlasResident
        } else {
            MegaLightsVisibilitySource::Off
        };
        self.frame_index = self.frame_index.wrapping_add(1);
    }

    /// IES 档位在灯池内的行号视图(重映射载荷的 spot 序;None = 恒 1)。
    pub(crate) fn ies_packing(&self) -> Option<MegaLightsIesPacking<'_>> {
        let (words, spot_count) = self.ies.as_ref()?;
        Some(MegaLightsIesPacking::new(words, *spot_count))
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
        }
    }
}

/// 帧遥测快照(词面与 TS FrameMetrics.megaLights 同构)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MegaLightsTelemetry {
    pub gate: MegaLightsGate,
    pub execution_leg: MegaLightsExecutionLeg,
    pub decision: DirectLightingPathDecision,
    pub pool_count: usize,
    pub ies_spot_count: usize,
    pub visibility_source: MegaLightsVisibilitySource,
    pub frame_index: u32,
}

/// 参与统一灯池的灯数(点/聚;方向光与半球不入池——方向光走方向光通路,
/// 半球无 MegaLight kind,如实不入池不虚报)。
fn count_pool_lights(lighting: &DirectionalLighting) -> (usize, usize) {
    let mut points = 0usize;
    let mut spots = 0usize;
    for light in lighting.local_lights.iter() {
        match light.kind {
            LocalLightKind::Point => points += 1,
            LocalLightKind::Spot => spots += 1,
            _ => {}
        }
    }
    (points, spots)
}

/// 视空间变换(TS `worldToView` 刚体 look-at 同口径:view z = −depth,前向为
/// −z;native basis 行 = (right, up, forward),第三行取负 = TS 的 backward 行;
/// 点带平移、方向只取行点积)。
fn to_view(view: PlayerView, world: [f32; 3], translate: bool) -> [f64; 3] {
    let [right, up, forward] = view.basis();
    let vector = if translate {
        let eye = view.eye();
        [
            f64::from(world[0]) - f64::from(eye[0]),
            f64::from(world[1]) - f64::from(eye[1]),
            f64::from(world[2]) - f64::from(eye[2]),
        ]
    } else {
        [
            f64::from(world[0]),
            f64::from(world[1]),
            f64::from(world[2]),
        ]
    };
    let dot = |row: [f32; 3]| -> f64 {
        f64::from(row[0]) * vector[0]
            + f64::from(row[1]) * vector[1]
            + f64::from(row[2]) * vector[2]
    };
    [dot(right), dot(up), -dot(forward)]
}

/// 作者局部灯 → 统一灯池(视空间;Disabled/Directional/Hemisphere 不入池)。
/// `ies_mapped` = IES 重映射成功:携带 IES 的 spot 按池序获得行号(与重映射
/// 迭代同序);否则恒 None(因子恒 1)。
fn build_view_space_pool(
    lighting: &DirectionalLighting,
    view: PlayerView,
    ies_mapped: bool,
) -> Vec<MegaLight> {
    let mut ies_ordinal = 0usize;
    lighting
        .local_lights
        .iter()
        .filter(|light| matches!(light.kind, LocalLightKind::Point | LocalLightKind::Spot))
        .map(|light: &LocalLight| {
            let is_spot = light.kind == LocalLightKind::Spot;
            let ies_spot_index = if is_spot && light.ies.is_some() && ies_mapped {
                let index = ies_ordinal;
                ies_ordinal += 1;
                Some(index as u32)
            } else {
                None
            };
            MegaLight {
                kind: if is_spot {
                    MegaLightKind::Spot
                } else {
                    MegaLightKind::Point
                },
                position_view: to_view(view, light.position, true),
                range: f64::from(light.range),
                color: [
                    f64::from(light.radiance[0]),
                    f64::from(light.radiance[1]),
                    f64::from(light.radiance[2]),
                ],
                intensity: 1.0,
                decay: f64::from(light.decay),
                direction_view: if is_spot {
                    to_view(view, light.direction, false)
                } else {
                    [0.0, 0.0, 1.0]
                },
                inner_cone_cos: f64::from(light.inner_cos),
                outer_cone_cos: f64::from(light.outer_cos),
                half_extent: [0.0, 0.0],
                two_sided: false,
                ies_spot_index,
            }
        })
        .collect()
}

/// 既有 IES 存储的表节起点(16 灯槽参数节之后;与 `ies_shading` 的
/// `IES_LIGHT_ROWS` 同值,本地互钉避免跨模块私有依赖)。
const IES_TABLE_SECTION_BASE: usize = 16;

/// IES 档位:light-slot 行 → spot-ordinal 行重映射(TS `packIesShading` 的
/// `[0, spotCount)` spot 参数节合同)。池序 spot 携带 IES 时,逐行拷贝既有
/// 4 词(profileIndex/rotationHalfDeg/scaleFactor/metaBase)并把 metaBase
/// 重定基到本载荷表节(spot 行数 + profile 序),表节(元数据 + 展开表,
/// 存储行 16..)逐词拷贝;`evaluate_ies_shading_factor` 的寻址合同
/// (spot 行 4 词 + metaBase→[tableBase,count,halfStep,symmetry])由测试对拍。
/// 任一环节缺失(profile 未声明/槽行缺省/表节缺席)整体 fail-closed 回退
/// None(因子恒 1),绝不半挂载。
fn remap_ies_spot_rows(
    lighting: &DirectionalLighting,
    storage_rows: Option<&[[f32; 4]]>,
) -> Option<(Vec<f32>, usize)> {
    let rows = storage_rows?;
    if rows.len() <= IES_TABLE_SECTION_BASE {
        return None;
    }
    let profiles = lighting.light_profiles.as_deref().unwrap_or_default();
    // 一趟携带槽行 4 词 + profile 序(metaBase 重定基需要两者)。
    let mut spot_rows: Vec<([f32; 4], usize)> = Vec::new();
    for (slot, light) in lighting.local_lights.iter().enumerate() {
        let (LocalLightKind::Spot, Some(ies)) = (&light.kind, &light.ies) else {
            continue;
        };
        let profile_index = profiles
            .iter()
            .position(|profile| profile.profile_id == ies.profile_id)?;
        let slot_row = rows.get(slot)?;
        if slot_row[0] < 0.0 {
            // 槽行缺省(-1)= 打包侧未登记该灯的 IES,合同不一致,整体回退。
            return None;
        }
        spot_rows.push((*slot_row, profile_index));
    }
    if spot_rows.is_empty() {
        return None;
    }
    let spot_count = spot_rows.len();
    let table_rows = rows.len() - IES_TABLE_SECTION_BASE;
    let metadata_rows = profiles.len().min(table_rows);
    let mut words = Vec::with_capacity(spot_count * 4 + table_rows * 4);
    for (row, profile_index) in &spot_rows {
        // metaBase 重定基:本载荷表节起点 = spot 行数;profile 元数据行 =
        // 表节起点 + profile 序(与 TS metaBase = spotCount + profileIndex 同式)。
        let mut remapped = *row;
        remapped[3] = (spot_count + profile_index) as f32;
        words.extend_from_slice(&remapped);
    }
    // 表节逐行拷贝;元数据行的 tableBase(word 0)同为 native 存储坐标,
    // 同步重定基:new = spotCount + (old − 16),否则 factor 求值越界回 0。
    for (offset, row) in rows.iter().skip(IES_TABLE_SECTION_BASE).enumerate() {
        let mut copied = *row;
        if offset < metadata_rows && copied[0] >= IES_TABLE_SECTION_BASE as f32 {
            copied[0] = (spot_count as f32) + copied[0] - IES_TABLE_SECTION_BASE as f32;
        }
        words.extend_from_slice(&copied);
    }
    Some((words, spot_count))
}

#[cfg(test)]
#[path = "megalights_runtime_tests.rs"]
mod megalights_runtime_tests;
