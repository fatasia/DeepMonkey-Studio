//! F3 Native GI 探针 ABI 合同（仅布局/预算/旧包兼容，不包含 producer 或着色消费）。
//!
//! 布局必须与 Web `packIrradianceProbeRecord` 逐字段一致：
//! 0..3 irradiance.xyz + validity，4..7 meanDistance + distanceVariance +
//! occlusionFloor + padding，8..11 positionOffset.xyz + padding，总计 96 字节。

use std::mem::size_of;

pub const PROBE_GI_ABI_VERSION: u32 = 1;
pub const PROBE_GI_RECORD_BYTES: usize = 96;
pub const PROBE_GI_RECORD_FLOATS: usize = 12;
pub const PROBE_GI_MAX_RECORDS: usize = 65_536;
pub const PROBE_GI_MAX_STORAGE_BYTES: usize = PROBE_GI_RECORD_BYTES * PROBE_GI_MAX_RECORDS;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct IrradianceProbeRecord {
    pub irradiance: [f32; 3],
    pub validity: f32,
    pub mean_distance: f32,
    pub distance_variance: f32,
    pub occlusion_floor: f32,
    pub padding: f32,
    pub position_offset: [f32; 3],
    pub position_padding: f32,
    /// Web 96B 合同保留区，当前必须为零，未来扩展不得改变前 48B 字段。
    pub reserved: [f32; 12],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeGiAbiError {
    InvalidRecord,
    RecordBudgetExceeded,
    ByteLayoutMismatch,
}

impl IrradianceProbeRecord {
    pub const fn zero() -> Self {
        Self { irradiance: [0.0; 3], validity: 0.0, mean_distance: 0.0,
            distance_variance: 0.0, occlusion_floor: 0.0, padding: 0.0,
            position_offset: [0.0; 3], position_padding: 0.0, reserved: [0.0; 12] }
    }

    pub fn validate(&self) -> Result<(), ProbeGiAbiError> {
        if !self.irradiance.iter().all(|value| value.is_finite() && *value >= 0.0 && *value <= 65_504.0)
            || !self.validity.is_finite() || !(0.0..=1.0).contains(&self.validity)
            || !self.mean_distance.is_finite() || !(0.0..=1_000_000.0).contains(&self.mean_distance)
            || !self.distance_variance.is_finite() || !(0.0..=1_000_000_000_000.0).contains(&self.distance_variance)
            || !self.occlusion_floor.is_finite() || !(0.0..=1.0).contains(&self.occlusion_floor)
            || !self.position_offset.iter().all(|value| value.is_finite() && value.abs() <= 1_000_000.0)
            || !self.reserved.iter().all(|value| value.is_finite() && *value == 0.0) || self.padding != 0.0 || self.position_padding != 0.0 {
            return Err(ProbeGiAbiError::InvalidRecord);
        }
        Ok(())
    }

    pub fn to_bytes(self) -> Result<[u8; PROBE_GI_RECORD_BYTES], ProbeGiAbiError> {
        self.validate()?;
        Ok(bytemuck::cast(self))
    }
}

pub fn validate_layout() -> Result<(), ProbeGiAbiError> {
    if size_of::<IrradianceProbeRecord>() != PROBE_GI_RECORD_BYTES {
        return Err(ProbeGiAbiError::ByteLayoutMismatch);
    }
    Ok(())
}

pub fn validate_record_count(count: usize) -> Result<usize, ProbeGiAbiError> {
    if count > PROBE_GI_MAX_RECORDS { return Err(ProbeGiAbiError::RecordBudgetExceeded); }
    let bytes = count.checked_mul(PROBE_GI_RECORD_BYTES).ok_or(ProbeGiAbiError::RecordBudgetExceeded)?;
    if bytes > PROBE_GI_MAX_STORAGE_BYTES { return Err(ProbeGiAbiError::RecordBudgetExceeded); }
    Ok(bytes)
}

pub fn pack_records(records: &[IrradianceProbeRecord]) -> Result<Vec<u8>, ProbeGiAbiError> {
    validate_layout()?;
    validate_record_count(records.len())?;
    let mut output = Vec::with_capacity(records.len() * PROBE_GI_RECORD_BYTES);
    for record in records { output.extend_from_slice(&record.to_bytes()?); }
    Ok(output)
}

pub fn empty_scene_allocation() -> Result<Vec<u8>, ProbeGiAbiError> {
    validate_record_count(0)?;
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> IrradianceProbeRecord {
        IrradianceProbeRecord { irradiance: [1.0, 2.0, 3.0], validity: 0.75,
            mean_distance: 4.0, distance_variance: 5.0, occlusion_floor: 0.1, padding: 0.0,
            position_offset: [0.2, -0.3, 0.4], position_padding: 0.0, reserved: [0.0; 12] }
    }

    #[test]
    fn layout_is_the_web_96_byte_contract() {
        assert_eq!(PROBE_GI_ABI_VERSION, 1);
        assert_eq!(size_of::<IrradianceProbeRecord>(), 96);
        assert_eq!(IrradianceProbeRecord::zero().to_bytes().unwrap().len(), 96);
    }

    #[test]
    fn packed_words_match_web_field_order() {
        let bytes = sample().to_bytes().unwrap();
        let words: Vec<f32> = bytes.chunks_exact(4)
            .map(|chunk| f32::from_ne_bytes(chunk.try_into().unwrap()))
            .collect();
        assert_eq!(&words[0..4], &[1.0, 2.0, 3.0, 0.75]);
        assert_eq!(&words[4..8], &[4.0, 5.0, 0.1, 0.0]);
        assert_eq!(&words[8..12], &[0.2, -0.3, 0.4, 0.0]);
    }

    #[test]
    fn invalid_values_fail_closed() {
        let mut invalid = sample(); invalid.validity = 2.0;
        assert_eq!(invalid.validate(), Err(ProbeGiAbiError::InvalidRecord));
        invalid = sample(); invalid.mean_distance = f32::NAN;
        assert_eq!(invalid.validate(), Err(ProbeGiAbiError::InvalidRecord));
        invalid = sample(); invalid.position_offset[0] = 2_000_000.0;
        assert_eq!(invalid.validate(), Err(ProbeGiAbiError::InvalidRecord));
    }

    #[test]
    fn record_budget_is_bounded_and_empty_scene_is_zero_allocation() {
        assert_eq!(validate_record_count(0).unwrap(), 0);
        assert!(empty_scene_allocation().unwrap().is_empty());
        assert_eq!(validate_record_count(PROBE_GI_MAX_RECORDS).unwrap(), PROBE_GI_MAX_STORAGE_BYTES);
        assert_eq!(validate_record_count(PROBE_GI_MAX_RECORDS + 1), Err(ProbeGiAbiError::RecordBudgetExceeded));
    }

    #[test]
    fn batch_packing_is_contiguous_and_deterministic() {
        let records = [sample(), sample()];
        let left = pack_records(&records).unwrap();
        let right = pack_records(&records).unwrap();
        assert_eq!(left, right);
        assert_eq!(left.len(), 192);
        assert_eq!(&left[..96], &left[96..]);
    }

    #[test]
    fn old_zero_record_payload_remains_valid() {
        // 旧包没有 probe 字段时等价于空记录；不分配，不阻断 IBL 路径。
        assert_eq!(pack_records(&[]).unwrap(), Vec::<u8>::new());
    }
}
