//! F3 Native GI 网格头合同与三线性采样 CPU 参考（多层级联）。
//!
//! 探针 storage（frame layout binding 11）在"网格三线性模式"下的记录流布局：
//!
//! **旧单层合同（保留区全零，逐位兼容）**：record 0 即网格头
//! - floats 0..3 = origin.xyz，float 3 = spacing
//! - floats 4..7 = gridSize.xyz（整数以 f32 承载），float 7 = baseProbeRecords（恒 1）
//! - floats 8..11 = maxPosition.xyz，float 11 = probeCount
//! - 其余（Rust `reserved` 12 floats）保持零。
//!
//! **v2 布局头合同（多层级联）**：record 0 是布局头——主 12 字全零，保留区声明
//! - `reserved[0]` = headerVersion（恒 2.0）
//! - `reserved[1]` = levelCount（1..=4，细→粗顺序）
//! - `reserved[2]` = levels 起始记录号（首个层级网格头所在记录，本版本恒 1）
//! - `reserved[3..12]` 必须全零（fail-closed）
//! 随后每层一个网格头记录（原格式，保留区全零），探针记录按层顺序排布。
//! 层头 `baseProbeRecords` 语义扩展为"本层首条探针记录号"= 布局头 + 前面所有层
//! 全部记录（各层头+探针）+ 本层网格头；旧单层下恒 1，与现合同逐位一致。
//!
//! 层间健全性合同（fail-closed）：粗层 spacing 必须严格大于细层，粗层范围
//! （origin..maxPosition）必须逐轴包含细层范围；记录流必须恰好排布完声明层数。
//!
//! 该模式由 `frame.lightDirection.w >= 1.5` 启用；`0` 为关闭（旧包逐位不变），
//! `1` 为既有最近探针扁平扫描。网格模式下的 `positionOffset` 是重定位增量
//! （探针世界位置 = origin + cell*spacing + offset），与 Web storage-record
//! 路径一致；最近探针模式仍把 positionOffset 当作预烘焙世界位置，两模式不同。
//!
//! 采样数学逐式对齐 Web `sampleIrradianceProbeClipmap`（probeClipmapSampling.ts）
//! 与 `probeClipmapSamplingWgsl.ts`：单层 = 三线性 × validity × Chebyshev 可见性
//! × 法线权重（bias=3），半球判断用原始着色点，接收点偏移 0.2 格只作用于可见性
//! 测试；级联 = 细层优先，粗层也包含采样点且两层权重都足够时按
//! `1 - smoothstep(0, 1.5 格边界距离)` 混合（Web `DEEP_GI_CASCADE_BLEND_CELLS`），
//! 细层权重不足而粗层足够时单独用粗层。

use crate::probe_gi_abi::{IrradianceProbeRecord, ProbeGiAbiError, PROBE_GI_RECORD_FLOATS};

/// 网格头占用的记录数；旧单层合同的探针记录从该下标开始。
pub const PROBE_GI_GRID_HEADER_RECORDS: usize = 1;

/// v2 布局头版本号（保留区 `reserved[0]`）。
pub const PROBE_GI_GRID_LAYOUT_VERSION: f32 = 2.0;
/// 级联最大层数，与 Web clipmap 采样上限（最多取 4 层）一致。
pub const PROBE_GI_GRID_MAX_LEVELS: usize = 4;
/// 层级混合带宽（格），与 Web `DEEP_GI_CASCADE_BLEND_CELLS` 一致。
pub const PROBE_GI_CASCADE_BLEND_CELLS: f32 = 1.5;

/// DDGI 法线权重陡峭度，与 Web `DEEP_GI_NORMAL_WEIGHT_BIAS` 一致。
pub const PROBE_GI_NORMAL_WEIGHT_BIAS: f32 = 3.0;
/// 接收点沿法线偏移格数，与 Web `DEEP_GI_NORMAL_BIAS_CELLS` 一致。
pub const PROBE_GI_NORMAL_BIAS_CELLS: f32 = 0.2;
/// 最小累计权重，与 Web `DEEP_GI_MIN_SAMPLE_WEIGHT` 一致。
pub const PROBE_GI_MIN_SAMPLE_WEIGHT: f32 = 0.001;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProbeGiGridHeader {
    pub origin: [f32; 3],
    pub spacing: f32,
    pub grid_size: [u32; 3],
    pub probe_count: u32,
}

/// v2 布局头（record 0）：主 12 字全零，保留区声明 version/levelCount/levels 起始。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProbeGiGridLayoutHeader {
    /// 层数（1..=4，细→粗）。
    pub level_count: u32,
    /// 首个层级网格头所在记录号（本版本恒 1）。
    pub levels_start_record: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeGiGridError {
    InvalidHeader,
    ProbeCountMismatch,
    RecordBudgetExceeded(ProbeGiAbiError),
}

impl From<ProbeGiAbiError> for ProbeGiGridError {
    fn from(value: ProbeGiAbiError) -> Self {
        Self::RecordBudgetExceeded(value.into())
    }
}

impl ProbeGiGridHeader {
    /// 旧单层合同编码：baseProbeRecords 恒 1（= 探针紧跟网格头）。
    pub fn encode(&self) -> Result<IrradianceProbeRecord, ProbeGiGridError> {
        self.encode_with_base(PROBE_GI_GRID_HEADER_RECORDS)
    }

    /// 级联编码：`base_probe_records` = 本层首条探针记录号
    /// （= 本层网格头记录号 + 1；旧单层 = 1，逐位不变）。
    pub fn encode_with_base(
        &self,
        base_probe_records: usize,
    ) -> Result<IrradianceProbeRecord, ProbeGiGridError> {
        self.validate()?;
        let mut record = IrradianceProbeRecord::zero();
        record.irradiance = self.origin;
        record.validity = self.spacing;
        record.mean_distance = self.grid_size[0] as f32;
        record.distance_variance = self.grid_size[1] as f32;
        record.occlusion_floor = self.grid_size[2] as f32;
        record.padding = base_probe_records as f32;
        record.position_offset = self.max_position();
        record.position_padding = self.probe_count as f32;
        Ok(record)
    }

    /// 旧单层合同解码（baseProbeRecords 恒 1）。
    pub fn decode(record: &IrradianceProbeRecord) -> Result<Self, ProbeGiGridError> {
        Self::decode_with_base(record, PROBE_GI_GRID_HEADER_RECORDS)
    }

    /// 级联解码：`base_probe_records` 必须等于本层首条探针记录号（调用方按
    /// 前面所有层累计推得）；`maxPosition` 必须 = origin + gridSize*spacing。
    pub fn decode_with_base(
        record: &IrradianceProbeRecord,
        base_probe_records: usize,
    ) -> Result<Self, ProbeGiGridError> {
        let header = Self {
            origin: record.irradiance,
            spacing: record.validity,
            grid_size: [
                record.mean_distance as u32,
                record.distance_variance as u32,
                record.occlusion_floor as u32,
            ],
            probe_count: record.position_padding as u32,
        };
        header.validate()?;
        // baseProbeRecords 必须指向本层首条探针（旧合同恒 1），maxPosition 必须
        // = origin + gridSize*spacing，层级网格头不得占用保留区。
        if record.padding != base_probe_records as f32
            || record.position_offset != header.max_position()
            || record.reserved.iter().any(|value| *value != 0.0)
        {
            return Err(ProbeGiGridError::InvalidHeader);
        }
        if header.probe_count as usize
            != header.grid_size[0] as usize * header.grid_size[1] as usize * header.grid_size[2] as usize
        {
            return Err(ProbeGiGridError::ProbeCountMismatch);
        }
        Ok(header)
    }

    fn max_position(&self) -> [f32; 3] {
        [
            self.origin[0] + self.grid_size[0] as f32 * self.spacing,
            self.origin[1] + self.grid_size[1] as f32 * self.spacing,
            self.origin[2] + self.grid_size[2] as f32 * self.spacing,
        ]
    }

    fn validate(&self) -> Result<(), ProbeGiGridError> {
        let finite_bounded = |value: f32, limit: f32| value.is_finite() && value.abs() <= limit;
        if !(finite_bounded(self.spacing, 1_000_000.0) && self.spacing > 0.0)
            || !self.origin.iter().all(|value| finite_bounded(*value, 1_000_000_000.0))
        {
            return Err(ProbeGiGridError::InvalidHeader);
        }
        if self.grid_size.iter().any(|size| *size < 2 || *size > 64) {
            return Err(ProbeGiGridError::InvalidHeader);
        }
        if !self.max_position().iter().all(|value| finite_bounded(*value, 1_000_000_000.0)) {
            return Err(ProbeGiGridError::InvalidHeader);
        }
        let count = self.grid_size[0] as usize * self.grid_size[1] as usize * self.grid_size[2] as usize;
        if count != self.probe_count as usize || count > PROBE_GI_MAX_GRID_PROBES {
            return Err(ProbeGiGridError::ProbeCountMismatch);
        }
        Ok(())
    }

    /// 采样点是否落在本层范围内（与 Web `contains` 一致，含边界）。
    pub fn contains(&self, world: [f32; 3]) -> bool {
        let max_position = self.max_position();
        (0..3).all(|axis| world[axis] >= self.origin[axis] && world[axis] <= max_position[axis])
    }

    /// 采样点到本层最近边界的距离（格）；与 Web `boundaryCells` 一致。
    pub fn boundary_cells(&self, world: [f32; 3]) -> f32 {
        (0..3)
            .map(|axis| {
                let coordinate = (world[axis] - self.origin[axis]) / self.spacing;
                coordinate.min(self.grid_size[axis] as f32 - 1.0 - coordinate)
            })
            .fold(f32::INFINITY, f32::min)
    }
}

impl ProbeGiGridLayoutHeader {
    /// 编码布局头：主 12 字全零，保留区 = [version, levelCount, levels 起始, 0...]。
    pub fn encode(&self) -> Result<IrradianceProbeRecord, ProbeGiGridError> {
        self.validate()?;
        let mut record = IrradianceProbeRecord::zero();
        record.reserved[0] = PROBE_GI_GRID_LAYOUT_VERSION;
        record.reserved[1] = self.level_count as f32;
        record.reserved[2] = self.levels_start_record as f32;
        Ok(record)
    }

    /// 解码布局头：版本未知、层数越界、levels 起始非 1、任何保留字/主字非零
    /// 一律 fail-closed（布局头是 v2 记录流的分派依据，宁可拒绝不可猜）。
    pub fn decode(record: &IrradianceProbeRecord) -> Result<Self, ProbeGiGridError> {
        let primary_zero = record.irradiance == [0.0; 3]
            && record.validity == 0.0
            && record.mean_distance == 0.0
            && record.distance_variance == 0.0
            && record.occlusion_floor == 0.0
            && record.padding == 0.0
            && record.position_offset == [0.0; 3]
            && record.position_padding == 0.0;
        if !primary_zero || record.reserved[0] != PROBE_GI_GRID_LAYOUT_VERSION {
            return Err(ProbeGiGridError::InvalidHeader);
        }
        let level_count = record.reserved[1];
        let levels_start = record.reserved[2];
        let level_count_ok = level_count >= 1.0
            && level_count <= PROBE_GI_GRID_MAX_LEVELS as f32
            && level_count == level_count.trunc();
        // levels 描述起始在本版本恒为 1（首个层级网格头紧跟布局头）。
        let levels_start_ok = levels_start == 1.0;
        if !level_count_ok
            || !levels_start_ok
            || record.reserved[3..].iter().any(|value| *value != 0.0)
        {
            return Err(ProbeGiGridError::InvalidHeader);
        }
        Ok(Self {
            level_count: level_count as u32,
            levels_start_record: levels_start as u32,
        })
    }

    fn validate(&self) -> Result<(), ProbeGiGridError> {
        if !(1..=PROBE_GI_GRID_MAX_LEVELS as u32).contains(&self.level_count)
            || self.levels_start_record != 1
        {
            return Err(ProbeGiGridError::InvalidHeader);
        }
        Ok(())
    }
}

/// 级联网格布局解码结果：层级网格头按细→粗顺序。
#[derive(Clone, Debug, PartialEq)]
pub struct ProbeGiGridCascade {
    /// `Some` = v2 布局头记录流；`None` = 旧单层（record 0 即唯一层网格头）。
    pub layout: Option<ProbeGiGridLayoutHeader>,
    /// 每层网格头（细→粗）。
    pub levels: Vec<ProbeGiGridHeader>,
    /// 每层网格头所在记录号（探针从该号 + 1 开始）。
    pub header_records: Vec<usize>,
}

/// 级联记录流解码与健全性校验（fail-closed）：
/// - record 0 保留区全零 → 旧单层合同（逐位兼容）；否则必须是合法 v2 布局头；
/// - 逐层解码网格头，`baseProbeRecords` 必须等于本层首条探针记录号；
/// - 粗层 spacing 严格更大、范围逐轴包含细层范围；
/// - 全部层记录总数不超过 ABI 预算，且记录流必须恰好排布完（无尾随/缺失）。
pub fn decode_probe_grid_cascade(
    records: &[IrradianceProbeRecord],
) -> Result<ProbeGiGridCascade, ProbeGiGridError> {
    if records.is_empty() {
        return Err(ProbeGiGridError::InvalidHeader);
    }
    let legacy = records[0].reserved.iter().all(|value| *value == 0.0);
    let layout = if legacy {
        None
    } else {
        Some(ProbeGiGridLayoutHeader::decode(&records[0])?)
    };
    let level_count = layout.as_ref().map_or(1, |layout| layout.level_count as usize);
    let mut cursor = layout.as_ref().map_or(0, |layout| layout.levels_start_record as usize);
    let mut levels: Vec<ProbeGiGridHeader> = Vec::with_capacity(level_count);
    let mut header_records: Vec<usize> = Vec::with_capacity(level_count);
    // 首层 baseProbeRecords = 本层网格头(1) + 前面所有层记录(布局头计入"前面记录")。
    let mut expected_base = cursor + 1;
    let mut total_records = cursor;
    for _index in 0..level_count {
        if cursor >= records.len() {
            return Err(ProbeGiGridError::InvalidHeader);
        }
        let header = ProbeGiGridHeader::decode_with_base(&records[cursor], expected_base)?;
        total_records += 1 + header.probe_count as usize;
        if total_records > crate::probe_gi_abi::PROBE_GI_MAX_RECORDS {
            return Err(ProbeGiGridError::RecordBudgetExceeded(
                ProbeGiAbiError::RecordBudgetExceeded,
            ));
        }
        if let Some(fine) = levels.last() {
            // 层间健全性：粗层间距严格更大，粗层范围逐轴包含细层范围。
            let fine_max = fine.max_position();
            let coarse_max = header.max_position();
            if !(header.spacing > fine.spacing)
                || (0..3).any(|axis| {
                    header.origin[axis] > fine.origin[axis] || coarse_max[axis] < fine_max[axis]
                })
            {
                return Err(ProbeGiGridError::InvalidHeader);
            }
        }
        levels.push(header);
        header_records.push(cursor);
        cursor += 1 + header.probe_count as usize;
        // cursor 现指向下一层网格头；其 baseProbeRecords = 头记录号 + 1。
        expected_base = cursor + 1;
    }
    // 记录流必须恰好排布完声明的层级（与旧单层 CPU 合同的精确计数一致）。
    if cursor != records.len() {
        return Err(ProbeGiGridError::InvalidHeader);
    }
    Ok(ProbeGiGridCascade { layout, levels, header_records })
}

/// 级联布局的 storage 字节打包：探针记录逐条走 ABI validate，头记录（v2 布局头
/// 占用保留区，层级网格头）由级联 decode 合同校验、原样写出。旧单层记录流经此
/// 打包与 `pack_records` 输出逐字节一致（头保留区为零、探针同序）。
pub fn pack_cascade_records(
    records: &[IrradianceProbeRecord],
) -> Result<Vec<u8>, ProbeGiGridError> {
    let cascade = decode_probe_grid_cascade(records)?;
    crate::probe_gi_abi::validate_record_count(records.len())?;
    // 头记录 = record 0（v2 布局头或旧单层网格头）+ 各层网格头,均由级联
    // decode 合同校验,不经 ABI 逐记录检查（布局头合法占用保留区）。
    let header_indices: Vec<usize> = if cascade.layout.is_some() {
        std::iter::once(0usize).chain(cascade.header_records.iter().copied()).collect()
    } else {
        cascade.header_records.clone()
    };
    let mut packed = Vec::with_capacity(records.len() * crate::probe_gi_abi::PROBE_GI_RECORD_BYTES);
    for (index, record) in records.iter().enumerate() {
        if !header_indices.contains(&index) {
            record.validate()?;
        }
        let bytes: &[u8] = bytemuck::bytes_of(record);
        packed.extend_from_slice(bytes);
    }
    Ok(packed)
}

/// 单层网格的探针预算上限：64^3 会超出 96B 记录的 65536 条预算，
/// 生产网格按 profile 收敛到远低于该值；此处钉死 ABI 总预算。
pub const PROBE_GI_MAX_GRID_PROBES: usize = 65_536 - PROBE_GI_GRID_HEADER_RECORDS;

/// 单层三线性采样结果：irradiance 已按累计权重归一（与 Web `LevelSample` 一致）。
struct ProbeGiLevelSample {
    irradiance: [f32; 3],
    weight: f32,
}

/// 与 WGSL `probe_gi_grid_sample_level` 逐式一致的层内采样：三线性 × validity
/// × Chebyshev × 法线权重；权重不足返回零值零权重（fail-closed）。
fn sample_grid_level(
    header: &ProbeGiGridHeader,
    records: &[IrradianceProbeRecord],
    header_record: usize,
    world: [f32; 3],
    n: [f32; 3],
) -> ProbeGiLevelSample {
    let zero = ProbeGiLevelSample { irradiance: [0.0; 3], weight: 0.0 };
    let spacing = header.spacing;
    let receiver = [
        world[0] + n[0] * spacing * PROBE_GI_NORMAL_BIAS_CELLS,
        world[1] + n[1] * spacing * PROBE_GI_NORMAL_BIAS_CELLS,
        world[2] + n[2] * spacing * PROBE_GI_NORMAL_BIAS_CELLS,
    ];
    let mut sum = [0.0f32; 3];
    let mut total_weight = 0.0f32;
    for corner in 0u32..8 {
        let bits = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
        let mut cell = [0u32; 3];
        let mut fraction = [0.0f32; 3];
        let mut trilinear = 1.0f32;
        for axis in 0..3 {
            let coordinate = ((world[axis] - header.origin[axis]) / spacing)
                .clamp(0.0, (header.grid_size[axis] - 1) as f32);
            let low = (coordinate.floor() as u32).min(header.grid_size[axis] - 2);
            cell[axis] = low + bits[axis];
            fraction[axis] = (coordinate - low as f32).clamp(0.0, 1.0);
            let weight = if bits[axis] == 1 { fraction[axis] } else { 1.0 - fraction[axis] };
            trilinear *= weight;
        }
        if !(trilinear > 0.0) {
            continue;
        }
        let linear = (cell[2] * header.grid_size[1] + cell[1]) * header.grid_size[0] + cell[0];
        if linear as usize >= header.probe_count as usize {
            continue;
        }
        let record = &records[header_record + 1 + linear as usize];
        let validity = record.validity.clamp(0.0, 1.0);
        if !(validity > 0.0) {
            continue;
        }
        let probe_position = [
            header.origin[0] + cell[0] as f32 * spacing + record.position_offset[0],
            header.origin[1] + cell[1] as f32 * spacing + record.position_offset[1],
            header.origin[2] + cell[2] as f32 * spacing + record.position_offset[2],
        ];
        // Chebyshev 可见性：接收点在 meanDistance 内直接通过，否则按距离方差衰减。
        let delta = [
            receiver[0] - probe_position[0],
            receiver[1] - probe_position[1],
            receiver[2] - probe_position[2],
        ];
        let distance = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt();
        let mean_distance = record.mean_distance.clamp(0.0, 1_000_000.0);
        let visibility = if distance <= mean_distance {
            1.0
        } else {
            let variance = record
                .distance_variance
                .clamp(spacing * spacing * 0.0001, 1_000_000_000_000.0);
            let excess = distance - mean_distance;
            let chebyshev = variance / (variance + excess * excess).max(0.000_001);
            record.occlusion_floor.clamp(0.0, 1.0).max(chebyshev)
        };
        // 法线权重：半球判断用原始着色点 world（不是偏移后的 receiver）。
        let to_probe = [
            probe_position[0] - world[0],
            probe_position[1] - world[1],
            probe_position[2] - world[2],
        ];
        let length_to_probe =
            (to_probe[0] * to_probe[0] + to_probe[1] * to_probe[1] + to_probe[2] * to_probe[2]).sqrt();
        let normal_weight = if length_to_probe > 0.000_001 {
            let cosine = (to_probe[0] * n[0] + to_probe[1] * n[1] + to_probe[2] * n[2]) / length_to_probe;
            if cosine > 0.0 {
                cosine.powf(PROBE_GI_NORMAL_WEIGHT_BIAS)
            } else {
                0.0
            }
        } else {
            1.0
        };
        let weight = trilinear * validity * visibility * normal_weight;
        for axis in 0..3 {
            sum[axis] += record.irradiance[axis].max(0.0) * weight;
        }
        total_weight += weight;
    }
    if total_weight < PROBE_GI_MIN_SAMPLE_WEIGHT {
        return zero;
    }
    ProbeGiLevelSample {
        irradiance: [
            (sum[0] / total_weight).clamp(0.0, 65_504.0),
            (sum[1] / total_weight).clamp(0.0, 65_504.0),
            (sum[2] / total_weight).clamp(0.0, 65_504.0),
        ],
        weight: total_weight,
    }
}

/// Web `smoothstep(low, high, value)`：x*x*(3-2x)，x 先夹到 [0,1]。
fn cascade_smoothstep(low: f32, high: f32, value: f32) -> f32 {
    let x = ((value - low) / (high - low)).clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Web `mix3(fine, coarse, blend)` 的同式实现（fine + (coarse - fine) * blend），
/// GPU 侧用同一公式保证 Native CPU/WGSL 逐位对拍。
fn cascade_mix(fine: [f32; 3], coarse: [f32; 3], blend: f32) -> [f32; 3] {
    [
        fine[0] + (coarse[0] - fine[0]) * blend,
        fine[1] + (coarse[1] - fine[1]) * blend,
        fine[2] + (coarse[2] - fine[2]) * blend,
    ]
}

/// 与 WGSL `probe_gi_grid_trilinear` 逐式一致的 CPU 参考（f32 运算顺序相同），
/// 供 parity 测试与宿主侧调试采样使用；不替代 GPU 路径。
/// 支持旧单层记录流与 v2 多层级联记录流；单层结果与旧合同逐位一致。
pub fn sample_probe_grid_irradiance(
    records: &[IrradianceProbeRecord],
    world: [f32; 3],
    normal: [f32; 3],
) -> [f32; 3] {
    let zero = [0.0f32; 3];
    if records.len() < PROBE_GI_GRID_HEADER_RECORDS + 1 {
        return zero;
    }
    if !world.iter().all(|value| value.is_finite() && value.abs() <= 1_000_000_000.0)
        || !normal.iter().all(|value| value.is_finite() && value.abs() <= 1_000_000.0)
    {
        return zero;
    }
    let cascade = match decode_probe_grid_cascade(records) {
        Ok(cascade) => cascade,
        Err(_) => return zero,
    };
    let normal_length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
    let n = if normal_length > 0.000_001 {
        [normal[0] / normal_length.max(0.000_001), normal[1] / normal_length.max(0.000_001), normal[2] / normal_length.max(0.000_001)]
    } else {
        [0.0, 1.0, 0.0]
    };
    // 细层优先：selected = 第一个（最细）包含采样点的层。
    let selected = match cascade
        .levels
        .iter()
        .position(|level| level.contains(world))
    {
        Some(index) => index,
        None => return zero,
    };
    let fine = sample_grid_level(
        &cascade.levels[selected],
        records,
        cascade.header_records[selected],
        world,
        n,
    );
    // 级联混合只看数组中紧随的下一层（与 Web MAX_LEVEL_SAMPLE_COUNT=2 一致），
    // 且要求该层也包含采样点（级联合同下由范围包含关系保证）。
    let next = selected + 1;
    if next < cascade.levels.len() && cascade.levels[next].contains(world) {
        let coarse = sample_grid_level(
            &cascade.levels[next],
            records,
            cascade.header_records[next],
            world,
            n,
        );
        if fine.weight >= PROBE_GI_MIN_SAMPLE_WEIGHT
            && coarse.weight >= PROBE_GI_MIN_SAMPLE_WEIGHT
        {
            let blend = 1.0
                - cascade_smoothstep(
                    0.0,
                    PROBE_GI_CASCADE_BLEND_CELLS,
                    cascade.levels[selected].boundary_cells(world),
                );
            return cascade_mix(fine.irradiance, coarse.irradiance, blend);
        }
        if coarse.weight >= PROBE_GI_MIN_SAMPLE_WEIGHT {
            return coarse.irradiance;
        }
    }
    if fine.weight >= PROBE_GI_MIN_SAMPLE_WEIGHT {
        return fine.irradiance;
    }
    let _ = PROBE_GI_RECORD_FLOATS;
    zero
}

#[cfg(test)]
mod probe_gi_grid_tests {
    use super::*;

    fn header(grid: [u32; 3], spacing: f32) -> ProbeGiGridHeader {
        ProbeGiGridHeader {
            origin: [1.0, 2.0, 3.0],
            spacing,
            grid_size: grid,
            probe_count: grid[0] * grid[1] * grid[2],
        }
    }

    fn uniform_records(grid: [u32; 3], spacing: f32, irradiance: [f32; 3]) -> Vec<IrradianceProbeRecord> {
        let head = header(grid, spacing);
        let mut records = vec![head.encode().unwrap()];
        for index in 0..head.probe_count {
            let mut record = IrradianceProbeRecord::zero();
            record.irradiance = irradiance;
            record.validity = 1.0;
            record.mean_distance = 1_000_000.0; // Chebyshev 恒通过
            let linear = index;
            let x = linear % grid[0];
            let y = (linear / grid[0]) % grid[1];
            let z = linear / (grid[0] * grid[1]);
            // 重定位增量置于零：探针世界位置 = origin + cell*spacing。
            let cell = [x as f32, y as f32, z as f32];
            record.position_offset = [
                head.origin[0] + cell[0] * spacing - (head.origin[0] + cell[0] * spacing),
                0.0,
                0.0,
            ];
            let _ = cell;
            records.push(record);
        }
        records
    }

    #[test]
    fn header_round_trips_and_rejects_invalid() {
        let head = header([4, 3, 2], 0.5);
        let record = head.encode().unwrap();
        assert_eq!(ProbeGiGridHeader::decode(&record).unwrap(), head);
        // spacing 非法
        let bad = ProbeGiGridHeader { spacing: 0.0, ..head };
        assert_eq!(bad.encode().unwrap_err(), ProbeGiGridError::InvalidHeader);
        // grid 越界（<2 或 >64）
        let bad = header([1, 3, 2], 0.5);
        assert_eq!(bad.encode().unwrap_err(), ProbeGiGridError::InvalidHeader);
        let bad = header([65, 3, 2], 0.5);
        assert_eq!(bad.encode().unwrap_err(), ProbeGiGridError::InvalidHeader);
        // probeCount 与 grid 体积不符
        let mut bad = header([2, 2, 2], 0.5);
        bad.probe_count = 7;
        assert_eq!(bad.encode().unwrap_err(), ProbeGiGridError::ProbeCountMismatch);
        // maxPosition 被篡改
        let mut record = head.encode().unwrap();
        record.position_offset = [0.0; 3];
        assert_eq!(
            ProbeGiGridHeader::decode(&record).unwrap_err(),
            ProbeGiGridError::InvalidHeader
        );
    }

    #[test]
    fn uniform_grid_returns_the_shared_irradiance() {
        let records = uniform_records([2, 2, 2], 1.0, [0.25, 0.5, 0.75]);
        // 网格内部任意点：8 角等值，权重归一后等于共享值。
        let value = sample_probe_grid_irradiance(&records, [1.75, 2.5, 3.5], [0.0, 1.0, 0.0]);
        for (axis, expected) in [0.25, 0.5, 0.75].iter().enumerate() {
            assert!((value[axis] - expected).abs() < 1e-6);
        }
        // 网格外返回零。
        assert_eq!(sample_probe_grid_irradiance(&records, [0.5, 2.5, 3.5], [0.0, 1.0, 0.0]), [0.0; 3]);
    }

    #[test]
    fn cell_center_uses_only_positive_hemisphere_probes() {
        // 2x1x2 网格（grid 每轴 >=2），把 -x 侧两角置为背面（法线 +x 时权重 0），
        // +x 侧两角携带高亮 irradiance：采样 interior 中点只应受 +x 侧影响。
        let grid = [2, 2, 2];
        let spacing = 1.0f32;
        let head = header(grid, spacing).encode().unwrap();
        let mut records = vec![head];
        for index in 0..8u32 {
            let mut record = IrradianceProbeRecord::zero();
            record.validity = 1.0;
            record.mean_distance = 1_000_000.0;
            let x = index % 2;
            record.irradiance = if x == 1 { [4.0, 0.0, 0.0] } else { [1.0, 0.0, 0.0] };
            records.push(record);
        }
        // 着色点位于 x=cell0/cell1 中间，法线 +x：-x 角被法线权重剔除。
        let value = sample_probe_grid_irradiance(&records, [1.5, 2.5, 3.5], [1.0, 0.0, 0.0]);
        assert!((value[0] - 4.0).abs() < 1e-5, "背面探针不应漏光, got {}", value[0]);
    }

    #[test]
    fn invalid_or_missing_records_fail_closed_to_zero() {
        // 记录数不足（缺探针）。
        let head = header([2, 2, 2], 1.0).encode().unwrap();
        assert_eq!(sample_probe_grid_irradiance(&[head], [1.5, 2.5, 3.5], [0.0, 1.0, 0.0]), [0.0; 3]);
        // 全部探针 validity=0。
        let records = uniform_records([2, 2, 2], 1.0, [1.0, 1.0, 1.0])
            .into_iter()
            .enumerate()
            .map(|(index, mut record)| {
                if index > 0 {
                    record.validity = 0.0;
                }
                record
            })
            .collect::<Vec<_>>();
        assert_eq!(sample_probe_grid_irradiance(&records, [1.5, 2.5, 3.5], [0.0, 1.0, 0.0]), [0.0; 3]);
        // 头非法（spacing 被清零）。
        let records = uniform_records([2, 2, 2], 1.0, [1.0, 1.0, 1.0]);
        let mut corrupted = records.clone();
        corrupted[0].validity = 0.0;
        assert_eq!(sample_probe_grid_irradiance(&corrupted, [1.5, 2.5, 3.5], [0.0, 1.0, 0.0]), [0.0; 3]);
    }

    // ---- v2 多层级联合同 ----

    const FINE_VALUE: [f32; 3] = [1.0, 2.0, 4.0];
    const COARSE_VALUE: [f32; 3] = [0.5, 1.0, 2.0];

    /// 细层 [4,4,4] sp1 origin0（范围 [0,4]³），粗层 [2,2,2] sp4 origin0
    /// （范围 [0,8]³ 完全包含细层，spacing 严格递增）。
    fn fine_header() -> ProbeGiGridHeader {
        ProbeGiGridHeader { origin: [0.0; 3], spacing: 1.0, grid_size: [4, 4, 4], probe_count: 64 }
    }
    fn coarse_header() -> ProbeGiGridHeader {
        ProbeGiGridHeader { origin: [0.0; 3], spacing: 4.0, grid_size: [2, 2, 2], probe_count: 8 }
    }

    /// 双层记录流：细层网格头(base=2) + 64 探针 + 粗层网格头(base=67) + 8 探针。
    fn two_level_records(fine_value: [f32; 3], fine_validity: f32,
        coarse_value: [f32; 3], coarse_validity: f32) -> Vec<IrradianceProbeRecord> {
        let layout = ProbeGiGridLayoutHeader { level_count: 2, levels_start_record: 1 };
        let mut records = vec![layout.encode().unwrap()];
        let fine = fine_header();
        records.push(fine.encode_with_base(2).unwrap());
        for _ in 0..fine.probe_count {
            let mut record = IrradianceProbeRecord::zero();
            record.irradiance = fine_value;
            record.validity = fine_validity;
            record.mean_distance = 1_000_000.0;
            records.push(record);
        }
        let coarse = coarse_header();
        records.push(coarse.encode_with_base(2 + fine.probe_count as usize + 1).unwrap());
        for _ in 0..coarse.probe_count {
            let mut record = IrradianceProbeRecord::zero();
            record.irradiance = coarse_value;
            record.validity = coarse_validity;
            record.mean_distance = 1_000_000.0;
            records.push(record);
        }
        records
    }

    #[test]
    fn layout_header_round_trips_and_rejects_invalid() {
        let layout = ProbeGiGridLayoutHeader { level_count: 2, levels_start_record: 1 };
        let record = layout.encode().unwrap();
        assert_eq!(ProbeGiGridLayoutHeader::decode(&record).unwrap(), layout);
        // 保留区字位置固定：[version, levelCount, levelsStart, 0...]，主 12 字全零。
        assert_eq!(record.reserved[0], PROBE_GI_GRID_LAYOUT_VERSION);
        assert_eq!(record.reserved[1], 2.0);
        assert_eq!(record.reserved[2], 1.0);
        assert!(record.reserved[3..].iter().all(|value| *value == 0.0));
        assert_eq!(record.irradiance, [0.0; 3]);
        assert_eq!(record.validity, 0.0);
        // 未知版本拒绝
        let mut bad = record;
        bad.reserved[0] = 3.0;
        assert_eq!(ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(), ProbeGiGridError::InvalidHeader);
        // 层数越界（0 与 5）与非整数
        for bad_count in [0.0, 5.0, 2.5] {
            let mut bad = record;
            bad.reserved[1] = bad_count;
            assert_eq!(
                ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(),
                ProbeGiGridError::InvalidHeader,
                "levelCount {bad_count}"
            );
        }
        // levels 起始非 1 / 非整数
        for bad_start in [0.0, 2.0, 1.5] {
            let mut bad = record;
            bad.reserved[2] = bad_start;
            assert_eq!(
                ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(),
                ProbeGiGridError::InvalidHeader,
                "levelsStart {bad_start}"
            );
        }
        // 保留区尾部非零 / 主字非零
        let mut bad = record;
        bad.reserved[7] = 1.0;
        assert_eq!(ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(), ProbeGiGridError::InvalidHeader);
        let mut bad = record;
        bad.irradiance = [0.0, 0.0, 1.0];
        assert_eq!(ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(), ProbeGiGridError::InvalidHeader);
    }

    #[test]
    fn versioned_single_level_decodes_like_legacy() {
        // levelCount=1 的 v2 记录流：层级解码与采样结果必须与旧单层完全一致。
        let legacy = uniform_records([3, 2, 2], 0.5, [0.25, 0.5, 0.75]);
        let head = ProbeGiGridHeader::decode(&legacy[0]).unwrap();
        let layout = ProbeGiGridLayoutHeader { level_count: 1, levels_start_record: 1 };
        let mut versioned = vec![layout.encode().unwrap()];
        versioned.push(head.encode_with_base(2).unwrap());
        versioned.extend_from_slice(&legacy[1..]);
        let cascade = decode_probe_grid_cascade(&versioned).unwrap();
        assert_eq!(cascade.layout.as_ref().unwrap().level_count, 1);
        assert_eq!(cascade.levels[0], head);
        assert_eq!(cascade.header_records, vec![1]);
        for world in [[1.25, 2.5, 3.5], [1.5, 2.75, 3.25]] {
            assert_eq!(
                sample_probe_grid_irradiance(&versioned, world, [0.0, 1.0, 0.0]),
                sample_probe_grid_irradiance(&legacy, world, [0.0, 1.0, 0.0]),
                "v2 单层与旧合同采样必须逐位一致 at {world:?}"
            );
        }
    }

    #[test]
    fn two_level_cascade_decodes_with_extended_base_records() {
        let records = two_level_records(FINE_VALUE, 1.0, COARSE_VALUE, 1.0);
        let cascade = decode_probe_grid_cascade(&records).unwrap();
        assert_eq!(cascade.levels, vec![fine_header(), coarse_header()]);
        // baseProbeRecords = 布局头(1) + 前面所有层记录 + 本层网格头。
        assert_eq!(cascade.header_records, vec![1, 66]);
        assert_eq!(records[1].padding, 2.0);
        assert_eq!(records[66].padding, 67.0);
        // 打包:v2 放行保留区布局头;网格头(padding=baseProbeRecords、v2 保留区)
        // 本就不在 ABI 逐记录校验范围内,网格流必须走级联打包路径。
        let packed = pack_cascade_records(&records).unwrap();
        assert_eq!(packed.len(), records.len() * 96);
        // 旧单层经级联打包 = 记录流原样字节(确定性、与 GPU 测试的字节布局一致)。
        let legacy = uniform_records([2, 2, 2], 1.0, [1.0, 1.0, 1.0]);
        let via_cascade = pack_cascade_records(&legacy).unwrap();
        let raw: Vec<u8> = legacy
            .iter()
            .flat_map(|record| bytemuck::bytes_of(record).to_vec())
            .collect();
        assert_eq!(via_cascade, raw, "旧单层级联打包必须与记录流原样字节逐字节一致");
    }

    #[test]
    fn two_level_cascade_blends_by_web_smoothstep() {
        let records = two_level_records(FINE_VALUE, 1.0, COARSE_VALUE, 1.0);
        // 细层深内部（边界距离 1.5 格 → smoothstep=1 → blend=0）→ 纯细层值。
        let deep = sample_probe_grid_irradiance(&records, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]);
        for axis in 0..3 {
            assert!((deep[axis] - FINE_VALUE[axis]).abs() < 1e-6, "deep[{axis}]={}", deep[axis]);
        }
        // 细层边界（边界距离 0 → blend=1）→ 纯粗层值。
        let edge = sample_probe_grid_irradiance(&records, [0.0, 1.5, 1.5], [0.0, 1.0, 0.0]);
        for axis in 0..3 {
            assert!((edge[axis] - COARSE_VALUE[axis]).abs() < 1e-6, "edge[{axis}]={}", edge[axis]);
        }
        // 中间带（边界距离 0.75 → blend=0.5）→ 逐式对齐 Web 公式的中点值。
        let world = [0.75, 1.5, 1.5];
        let blended = sample_probe_grid_irradiance(&records, world, [0.0, 1.0, 0.0]);
        let boundary = fine_header().boundary_cells(world);
        assert!((boundary - 0.75).abs() < 1e-6);
        let blend = 1.0 - cascade_smoothstep(0.0, PROBE_GI_CASCADE_BLEND_CELLS, boundary);
        assert!((blend - 0.5).abs() < 1e-6);
        for axis in 0..3 {
            let expected = FINE_VALUE[axis] + (COARSE_VALUE[axis] - FINE_VALUE[axis]) * blend;
            assert!((blended[axis] - expected).abs() < 1e-6, "blended[{axis}]={}", blended[axis]);
        }
    }

    #[test]
    fn coarse_fallback_when_fine_weight_is_insufficient() {
        // 细层 validity 全零 → 权重不足 → 单独落粗层（Web fallback 语义）。
        let records = two_level_records(FINE_VALUE, 0.0, COARSE_VALUE, 1.0);
        let value = sample_probe_grid_irradiance(&records, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]);
        for axis in 0..3 {
            assert!((value[axis] - COARSE_VALUE[axis]).abs() < 1e-6, "value[{axis}]={}", value[axis]);
        }
        // 反向：粗层权重不足而细层足够 → 纯细层值（不走混合分支）。
        let records = two_level_records(FINE_VALUE, 1.0, COARSE_VALUE, 0.0);
        let value = sample_probe_grid_irradiance(&records, [0.0, 1.5, 1.5], [0.0, 1.0, 0.0]);
        for axis in 0..3 {
            assert!((value[axis] - FINE_VALUE[axis]).abs() < 1e-6, "value[{axis}]={}", value[axis]);
        }
        // 两层都权重不足 → fail-closed 返零。
        let records = two_level_records(FINE_VALUE, 0.0, COARSE_VALUE, 0.0);
        assert_eq!(
            sample_probe_grid_irradiance(&records, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]),
            [0.0; 3]
        );
    }

    #[test]
    fn invalid_multi_level_layouts_fail_closed() {
        let valid = two_level_records(FINE_VALUE, 1.0, COARSE_VALUE, 1.0);
        // 粗层 spacing 未严格递增（= 细层）。
        let mut bad = valid.clone();
        bad[66].validity = bad[1].validity;
        assert!(decode_probe_grid_cascade(&bad).is_err());
        assert_eq!(
            sample_probe_grid_irradiance(&bad, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]),
            [0.0; 3]
        );
        // 粗层范围不包含细层（origin 平移出界）。
        let mut bad = valid.clone();
        bad[66].irradiance = [10.0, 0.0, 0.0];
        assert!(decode_probe_grid_cascade(&bad).is_err());
        // 层头 baseProbeRecords 被篡改。
        let mut bad = valid.clone();
        bad[66].padding = 3.0;
        assert!(decode_probe_grid_cascade(&bad).is_err());
        // 层头占用保留区。
        let mut bad = valid.clone();
        bad[1].reserved[0] = 1.0;
        assert!(decode_probe_grid_cascade(&bad).is_err());
        // 尾随多余记录 / 缺失记录。
        let mut bad = valid.clone();
        bad.push(IrradianceProbeRecord::zero());
        assert!(decode_probe_grid_cascade(&bad).is_err());
        let bad = valid[..valid.len() - 1].to_vec();
        assert!(decode_probe_grid_cascade(&bad).is_err());
        // 声明层数 4 但只排布 2 层。
        let mut bad = valid;
        bad[0].reserved[1] = 4.0;
        assert!(decode_probe_grid_cascade(&bad).is_err());
        assert_eq!(
            sample_probe_grid_irradiance(&bad, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]),
            [0.0; 3]
        );
    }

    #[test]
    fn cascade_record_budget_is_fail_closed() {
        // 40³ + 12³ 双层总计 1+1+64000+1+1728 = 65731 > 65536 → 预算拒绝。
        let layout = ProbeGiGridLayoutHeader { level_count: 2, levels_start_record: 1 };
        let mut records = vec![layout.encode().unwrap()];
        let big = ProbeGiGridHeader { origin: [0.0; 3], spacing: 1.0, grid_size: [40, 40, 40], probe_count: 64_000 };
        let small = ProbeGiGridHeader { origin: [0.0; 3], spacing: 2.0, grid_size: [12, 12, 12], probe_count: 1_728 };
        records.push(big.encode_with_base(2).unwrap());
        for _ in 0..big.probe_count {
            records.push(IrradianceProbeRecord::zero());
        }
        records.push(small.encode_with_base(records.len() + 1).unwrap());
        for _ in 0..small.probe_count {
            records.push(IrradianceProbeRecord::zero());
        }
        assert_eq!(
            decode_probe_grid_cascade(&records).unwrap_err(),
            ProbeGiGridError::RecordBudgetExceeded(ProbeGiAbiError::RecordBudgetExceeded)
        );
    }
}

