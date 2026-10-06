//! P1 质量主线(六引擎对标刀位 2):MegaLights 灯池 ABI 与统一灯光结构。
//!
//! 与 TS `megaLights.ts` / `megaLightsAbi.ts` 逐字互钉:64B/灯 union 灯池布局、
//! kind 编码、RIS 预算常数;打包与 sha256 词流指纹供 fixture 对拍与 GPU 上传
//! 共用。采样/着色数学在 [`crate::megalights_ris`]。

use crate::megalights_ies::MegaLightsIesPacking;
use crate::shader_package::hash::sha256;

/// ABI 版本(与 TS `MEGA_LIGHT_ABI_VERSION` 互钉)。
pub const MEGA_LIGHT_ABI_VERSION: u32 = 1;
/// 每灯 64B = 4 vec4 = 16 f32。
pub const MEGA_LIGHT_STRIDE_BYTES: usize = 64;
pub const MEGA_LIGHT_STRIDE_VEC4: usize = 4;
pub const MEGA_LIGHT_WORDS: usize = 16;
/// kind 编码(f32 精确整数;与 WGSL DEEP_MEGA_LIGHT_KIND_* 逐字互钉)。
pub const MEGA_LIGHT_KIND_POINT: u32 = 0;
pub const MEGA_LIGHT_KIND_SPOT: u32 = 1;
pub const MEGA_LIGHT_KIND_AREA_RECT: u32 = 2;
/// 万灯池合同上限。
pub const MAX_MEGA_LIGHTS: usize = 65_535;
/// RIS 采样预算(任务书定值):像素级 K=32 候选 → resample M=1。
pub const MEGALIGHTS_RIS_CANDIDATES: u32 = 32;
pub const MEGALIGHTS_RIS_M: u32 = 1;
/// 空间复用波前半径:5×5 邻域(半径 2)。
pub const MEGALIGHTS_SPATIAL_REUSE_RADIUS: i32 = 2;
/// 既有簇光快路径的灯数决策点(与 [`crate::clustered_lighting`] 组合)。
pub const MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET: usize = 64;
/// 蓄水池无效胜者哨兵。
pub const MEGALIGHTS_INVALID_LIGHT: u32 = 0xffff_ffff;
/// 时域复用相似门:视深相对差(M1 视深门)。
pub const MEGALIGHTS_TEMPORAL_DEPTH_GATE: f64 = 0.1;
/// 空间复用相似门:法线点积下限。
pub const MEGALIGHTS_SPATIAL_NORMAL_GATE: f64 = 0.9;
/// 颜色 EMA 缺省系数(首帧 previousColor 缺省 = 全量替换)。
pub const MEGALIGHTS_DEFAULT_ALPHA_BLEND: f64 = 1.0 / 32.0;

/// 统一 MegaLight 记录(点/聚/面积三型 union;f64 字段 = TS 结构直映)。
#[derive(Debug, Clone, PartialEq)]
pub struct MegaLight {
    pub kind: MegaLightKind,
    pub position_view: [f64; 3],
    /// 硬截断半径;0 = 无窗口。
    pub range: f64,
    pub color: [f64; 3],
    pub intensity: f64,
    /// 点/聚光衰减指数([0,4]);面积光不消费(打包恒 2)。
    pub decay: f64,
    /// 聚光朝向 / 面积光发射面法线(打包时归一化)。
    pub direction_view: [f64; 3],
    /// 聚光锥(-1 ≤ outer ≤ inner ≤ 1;spot 缺省语义由构造辅助展开)。
    pub inner_cone_cos: f64,
    pub outer_cone_cos: f64,
    /// 面积光半宽/半高。
    pub half_extent: [f64; 2],
    /// 面积光双面发光。
    pub two_sided: bool,
    /// 复用既有 iesShading storage 的 spot 参数行号(2026-10-06 IES 注入切片:
    /// 64B ABI 字 11 = 行号+1,0 = 无 IES;缺省 None 与 v1 打包逐位一致)。
    pub ies_spot_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MegaLightKind {
    Point,
    Spot,
    AreaRect,
}

impl MegaLightKind {
    fn code(self) -> u32 {
        match self {
            MegaLightKind::Point => MEGA_LIGHT_KIND_POINT,
            MegaLightKind::Spot => MEGA_LIGHT_KIND_SPOT,
            MegaLightKind::AreaRect => MEGA_LIGHT_KIND_AREA_RECT,
        }
    }
}

impl Default for MegaLight {
    fn default() -> Self {
        Self {
            kind: MegaLightKind::Point,
            position_view: [0.0; 3],
            range: 0.0,
            color: [0.0; 3],
            intensity: 0.0,
            decay: 2.0,
            direction_view: [0.0, 0.0, 1.0],
            inner_cone_cos: 1.0,
            outer_cone_cos: -1.0,
            half_extent: [0.0, 0.0],
            two_sided: false,
            ies_spot_index: None,
        }
    }
}

/// GBuffer 表面行(GPU 3-vec4 布局的 CPU 形态):
/// [0]=(positionView.xyz, metallic) [1]=(normalView.xyz, roughness) [2]=(baseColor.xyz, 预留)。
pub type MegaSurfaceRow = [[f64; 4]; 3];

/// 蓄水池(单像素单 M 流;weightSum 为 f64 = JS number 语义)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RisReservoir {
    /// Σt_k(候选目标权重和)。
    pub weight_sum: f64,
    /// 胜者灯下标;`MEGALIGHTS_INVALID_LIGHT` = 无有效候选。
    pub winner: u32,
    /// 已合并候选总数(K 与时域/空间合并的 M 之和)。
    pub m: u32,
}

impl Default for RisReservoir {
    fn default() -> Self {
        Self {
            weight_sum: 0.0,
            winner: MEGALIGHTS_INVALID_LIGHT,
            m: 0,
        }
    }
}

/// 帧配置(与 TS `MegaLightsFrameConfig` 同形)。
#[derive(Debug, Clone)]
pub struct MegaLightsFrameConfig {
    pub width: u32,
    pub height: u32,
    /// K 候选数(缺省 32;穷举对拍模式自动 ≥N)。
    pub candidate_count: Option<u32>,
    pub temporal: bool,
    pub spatial: bool,
    /// 穷举对拍模式:逐灯求和(⑤ 退化一致性腿)。
    pub exhaustive: bool,
    /// 颜色 EMA 系数(temporal 开启时生效;None = 1/32)。
    pub alpha_blend: Option<f64>,
}

impl MegaLightsFrameConfig {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            candidate_count: None,
            temporal: true,
            spatial: true,
            exhaustive: false,
            alpha_blend: None,
        }
    }
}

/// 帧输入(与 TS `MegaLightsFrameInput` 同形)。
pub struct MegaLightsFrameInput<'a> {
    pub lights: &'a [MegaLight],
    /// 行主序 w×h 表面。
    pub surfaces: &'a [MegaSurfaceRow],
    /// 上一帧蓄水池(temporal 开启且长度吻合时合并)。
    pub previous: Option<&'a [RisReservoir]>,
    /// 每像素当前→上一帧 UV 运动(previous = pixel + 0.5 + motion)。
    pub motion_uv: Option<&'a [f64]>,
    /// 上一帧 EMA 颜色(w×h×3 f32 词)。
    pub previous_color: Option<&'a [f32]>,
    /// 每像素胜者可见性 mask(1=可见/0=遮挡;只乘 shade 侧)。
    pub visibility: Option<&'a [f32]>,
    /// E02 IES 打包载荷(2026-10-06 IES 注入切片;缺省 None = 因子恒 1,
    /// 与 v1 帧输出逐位一致)。
    pub ies: Option<&'a MegaLightsIesPacking<'a>>,
    pub frame: u32,
    pub config: MegaLightsFrameConfig,
}

/// 帧输出。
pub struct MegaLightsFrameOutput {
    /// 线性 RGB(w×h×3,f32 落点 = TS Float32Array)。
    pub color: Vec<f32>,
    pub reservoirs: Vec<RisReservoir>,
}

// ---- 灯池打包(TS packMegaLights 同构;f32 词位级对拍由 fixture 钉) ----

/// 打包结果(与 TS PackedMegaLights 同形)。
pub struct PackedMegaLights {
    /// [max(count,1) × 16 f32];无灯时为最小占位(1 灯槽全零)。
    pub data: Vec<f32>,
    pub count: usize,
    pub point_count: usize,
    pub spot_count: usize,
    pub area_count: usize,
    /// 打包中最高引用的 ies 行号 +1(0 = 无 IES 引用;TS iesReferenceCount 同语义,
    /// runtime 据此校验 ies 载荷闭合)。
    pub ies_reference_count: usize,
}

/// TS Math.hypot 的 Rust 端(跨 libm 哨兵;非位级锚)。
fn hypot3(value: [f64; 3]) -> f64 {
    f64::hypot(f64::hypot(value[0], value[1]), value[2])
}

fn normalize3(value: [f64; 3]) -> [f64; 3] {
    let length = hypot3(value);
    [value[0] / length, value[1] / length, value[2] / length]
}

/// 打包进 64B/灯 灯池(尾部灯槽清零 = kind=point 全零零贡献,字节稳定可 diff)。
pub fn pack_mega_lights(lights: &[MegaLight]) -> PackedMegaLights {
    assert!(
        lights.len() <= MAX_MEGA_LIGHTS,
        "mega light count exceeds {MAX_MEGA_LIGHTS}"
    );
    let mut data = vec![0.0f32; lights.len().max(1) * MEGA_LIGHT_WORDS];
    let mut point_count = 0usize;
    let mut spot_count = 0usize;
    let mut area_count = 0usize;
    let mut ies_reference_count = 0usize;
    for (index, light) in lights.iter().enumerate() {
        match light.kind {
            MegaLightKind::Point => point_count += 1,
            MegaLightKind::Spot => spot_count += 1,
            MegaLightKind::AreaRect => area_count += 1,
        }
        // IES 行号(f32 精确整数;0 = 无;行号+1 与 TS exactFloat 同合同,越界即拒)。
        let ies_word = match light.ies_spot_index {
            None => 0.0f32,
            Some(ies_index) => {
                assert!(
                    (ies_index as usize) < MAX_MEGA_LIGHTS && ies_index + 1 < (1 << 24),
                    "mega light ies spot index must be an f32-exact small row index"
                );
                ies_reference_count = ies_reference_count.max(ies_index as usize + 1);
                (ies_index + 1) as f32
            }
        };
        let base = index * MEGA_LIGHT_WORDS;
        data[base] = light.position_view[0] as f32;
        data[base + 1] = light.position_view[1] as f32;
        data[base + 2] = light.position_view[2] as f32;
        data[base + 3] = light.kind.code() as f32;
        data[base + 4] = (light.color[0] * light.intensity) as f32;
        data[base + 5] = (light.color[1] * light.intensity) as f32;
        data[base + 6] = (light.color[2] * light.intensity) as f32;
        data[base + 7] = light.range as f32;
        let direction = if light.kind == MegaLightKind::Point {
            [0.0, 0.0, 1.0]
        } else {
            normalize3(light.direction_view)
        };
        data[base + 8] = direction[0] as f32;
        data[base + 9] = direction[1] as f32;
        data[base + 10] = direction[2] as f32;
        data[base + 11] = ies_word;
        match light.kind {
            MegaLightKind::Point => {
                data[base + 12] = (light.decay - 2.0) as f32;
            }
            MegaLightKind::Spot => {
                let cone_scale = if light.inner_cone_cos == light.outer_cone_cos {
                    0.0
                } else {
                    1.0 / (light.inner_cone_cos - light.outer_cone_cos)
                };
                data[base + 12] = light.inner_cone_cos as f32;
                data[base + 13] = light.outer_cone_cos as f32;
                data[base + 14] = cone_scale as f32;
                data[base + 15] = (light.decay - 2.0) as f32;
            }
            MegaLightKind::AreaRect => {
                data[base + 12] = light.half_extent[0] as f32;
                data[base + 13] = light.half_extent[1] as f32;
                data[base + 14] = if light.two_sided { 1.0 } else { 0.0 };
            }
        }
    }
    assert!(
        data.iter().all(|word| !word.is_nan()),
        "mega lights packing produced NaN"
    );
    PackedMegaLights {
        data,
        count: lights.len(),
        point_count,
        spot_count,
        area_count,
        ies_reference_count,
    }
}

/// f32 词流 SHA-256(LE;fixture 词流指纹,TS 生成器同式)。
pub fn sha256_of_words(words: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(words.len() * 4);
    for word in words {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    sha256(&bytes)
}
