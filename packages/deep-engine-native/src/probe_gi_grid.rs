//! F3 Native GI 网格头合同与三线性采样 CPU 参考。
//!
//! 探针 storage（frame layout binding 11）在"网格三线性模式"下把第一条记录
//! （record 0，96B）用作网格头：
//! - floats 0..3 = origin.xyz，float 3 = spacing
//! - floats 4..7 = gridSize.xyz（整数以 f32 承载），float 7 = baseProbeRecords（恒 1）
//! - floats 8..11 = maxPosition.xyz，float 11 = probeCount
//! - 其余（Rust `reserved` 12 floats）保持零。
//!
//! 该模式由 `frame.lightDirection.w >= 1.5` 启用；`0` 为关闭（旧包逐位不变），
//! `1` 为既有最近探针扁平扫描。网格模式下的 `positionOffset` 是重定位增量
//! （探针世界位置 = origin + cell*spacing + offset），与 Web storage-record
//! 路径一致；最近探针模式仍把 positionOffset 当作预烘焙世界位置，两模式不同。
//!
//! 采样数学逐式对齐 Web `sampleIrradianceProbeClipmap`（probeClipmapSampling.ts）
//! 的单层路径：三线性 × validity × Chebyshev 可见性 × 法线权重（bias=3），
//! 半球判断用原始着色点，接收点偏移 0.2 格只作用于可见性测试；
//! 多层级联混合不在本切片（Native 目前单层网格头）。

use crate::probe_gi_abi::{IrradianceProbeRecord, ProbeGiAbiError, PROBE_GI_RECORD_FLOATS};

/// 网格头占用的记录数；探针记录从该下标开始。
pub const PROBE_GI_GRID_HEADER_RECORDS: usize = 1;

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
    pub fn encode(&self) -> Result<IrradianceProbeRecord, ProbeGiGridError> {
        self.validate()?;
        let mut record = IrradianceProbeRecord::zero();
        record.irradiance = self.origin;
        record.validity = self.spacing;
        record.mean_distance = self.grid_size[0] as f32;
        record.distance_variance = self.grid_size[1] as f32;
        record.occlusion_floor = self.grid_size[2] as f32;
        record.padding = PROBE_GI_GRID_HEADER_RECORDS as f32;
        record.position_offset = self.max_position();
        record.position_padding = self.probe_count as f32;
        Ok(record)
    }

    pub fn decode(record: &IrradianceProbeRecord) -> Result<Self, ProbeGiGridError> {
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
        // baseProbeRecords 必须恒为 1，maxPosition 必须 = origin + gridSize*spacing。
        if record.padding != PROBE_GI_GRID_HEADER_RECORDS as f32
            || record.position_offset != header.max_position()
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
}

/// 单层网格的探针预算上限：64^3 会超出 96B 记录的 65536 条预算，
/// 生产网格按 profile 收敛到远低于该值；此处钉死 ABI 总预算。
pub const PROBE_GI_MAX_GRID_PROBES: usize = 65_536 - PROBE_GI_GRID_HEADER_RECORDS;

/// 与 WGSL `probe_gi_grid_trilinear` 逐式一致的 CPU 参考（f32 运算顺序相同），
/// 供 parity 测试与宿主侧调试采样使用；不替代 GPU 路径。
pub fn sample_probe_grid_irradiance(
    records: &[IrradianceProbeRecord],
    world: [f32; 3],
    normal: [f32; 3],
) -> [f32; 3] {
    let zero = [0.0f32; 3];
    if records.len() < PROBE_GI_GRID_HEADER_RECORDS + 1 {
        return zero;
    }
    let header = match ProbeGiGridHeader::decode(&records[0]) {
        Ok(header) => header,
        Err(_) => return zero,
    };
    // 头之后必须恰好携带 probe_count 条探针记录。
    if records.len() != PROBE_GI_GRID_HEADER_RECORDS + header.probe_count as usize {
        return zero;
    }
    if !world.iter().all(|value| value.is_finite() && value.abs() <= 1_000_000_000.0)
        || !normal.iter().all(|value| value.is_finite() && value.abs() <= 1_000_000.0)
    {
        return zero;
    }
    let max_position = header.max_position();
    if (0..3).any(|axis| world[axis] < header.origin[axis] || world[axis] > max_position[axis]) {
        return zero;
    }
    let normal_length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
    let n = if normal_length > 0.000_001 {
        [normal[0] / normal_length.max(0.000_001), normal[1] / normal_length.max(0.000_001), normal[2] / normal_length.max(0.000_001)]
    } else {
        [0.0, 1.0, 0.0]
    };
    let receiver = [
        world[0] + n[0] * header.spacing * PROBE_GI_NORMAL_BIAS_CELLS,
        world[1] + n[1] * header.spacing * PROBE_GI_NORMAL_BIAS_CELLS,
        world[2] + n[2] * header.spacing * PROBE_GI_NORMAL_BIAS_CELLS,
    ];
    let mut sum = [0.0f32; 3];
    let mut total_weight = 0.0f32;
    for corner in 0u32..8 {
        let bits = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
        let mut cell = [0u32; 3];
        let mut fraction = [0.0f32; 3];
        let mut trilinear = 1.0f32;
        for axis in 0..3 {
            let coordinate = ((world[axis] - header.origin[axis]) / header.spacing)
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
        let record = &records[PROBE_GI_GRID_HEADER_RECORDS + linear as usize];
        let validity = record.validity.clamp(0.0, 1.0);
        if !(validity > 0.0) {
            continue;
        }
        let probe_position = [
            header.origin[0] + cell[0] as f32 * header.spacing + record.position_offset[0],
            header.origin[1] + cell[1] as f32 * header.spacing + record.position_offset[1],
            header.origin[2] + cell[2] as f32 * header.spacing + record.position_offset[2],
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
                .clamp(header.spacing * header.spacing * 0.0001, 1_000_000_000_000.0);
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
    let _ = PROBE_GI_RECORD_FLOATS;
    [
        (sum[0] / total_weight).clamp(0.0, 65_504.0),
        (sum[1] / total_weight).clamp(0.0, 65_504.0),
        (sum[2] / total_weight).clamp(0.0, 65_504.0),
    ]
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
}
