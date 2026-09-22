//! F3 Native GI 探针存储与绑定合同。
//!
//! 该模块只负责把已验证的 96B 探针记录拥有化为 Native storage buffer，
//! 不改变既有 IBL frame layout，也不宣称已经接入着色器采样。

use crate::probe_gi_abi::{
    IrradianceProbeRecord, PROBE_GI_RECORD_BYTES, ProbeGiAbiError, pack_records,
    validate_record_count,
};

pub const PROBE_GI_STORAGE_BINDING: u32 = 0;
pub const PROBE_GI_STORAGE_MIN_BINDING_BYTES: u64 = PROBE_GI_RECORD_BYTES as u64;

#[derive(Debug, PartialEq, Eq)]
pub enum ProbeGiStorageError {
    Abi(ProbeGiAbiError),
    DeviceLimitExceeded,
}

impl From<ProbeGiAbiError> for ProbeGiStorageError {
    fn from(value: ProbeGiAbiError) -> Self {
        Self::Abi(value)
    }
}

/// Renderer 独占的探针 storage 资源。
///
/// `None` 表示没有探针，调用方不得为旧包或空场景创建占位 buffer。
/// 该对象不跨设备复用，设备恢复时必须随 Renderer 一起重建。
pub struct ProbeGiStorage {
    buffer: wgpu::Buffer,
    layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    record_count: usize,
    byte_len: u64,
}

impl ProbeGiStorage {
    /// 为非空探针记录创建真实 GPU storage 与独立 bind group。
    pub fn new(
        device: &wgpu::Device,
        records: &[IrradianceProbeRecord],
    ) -> Result<Option<Self>, ProbeGiStorageError> {
        if records.is_empty() {
            validate_record_count(0)?;
            return Ok(None);
        }
        let packed = pack_records(records)?;
        let byte_len =
            u64::try_from(packed.len()).map_err(|_| ProbeGiStorageError::DeviceLimitExceeded)?;
        if byte_len < PROBE_GI_STORAGE_MIN_BINDING_BYTES
            || byte_len > device.limits().max_storage_buffer_binding_size as u64
        {
            return Err(ProbeGiStorageError::DeviceLimitExceeded);
        }

        use wgpu::util::DeviceExt;
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native irradiance probe storage"),
            contents: &packed,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Deep Engine native irradiance probe layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: PROBE_GI_STORAGE_BINDING,
                visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(PROBE_GI_STORAGE_MIN_BINDING_BYTES),
                },
                count: None,
            }],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native irradiance probe bindings"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: PROBE_GI_STORAGE_BINDING,
                resource: buffer.as_entire_binding(),
            }],
        });
        Ok(Some(Self {
            buffer,
            layout,
            bind_group,
            record_count: records.len(),
            byte_len,
        }))
    }

    pub fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }
    pub fn layout(&self) -> &wgpu::BindGroupLayout {
        &self.layout
    }
    pub fn bind_group(&self) -> &wgpu::BindGroup {
        &self.bind_group
    }
    pub fn record_count(&self) -> usize {
        self.record_count
    }
    pub fn byte_len(&self) -> u64 {
        self.byte_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> IrradianceProbeRecord {
        IrradianceProbeRecord {
            irradiance: [1.0, 2.0, 3.0],
            validity: 1.0,
            mean_distance: 2.0,
            distance_variance: 3.0,
            occlusion_floor: 0.1,
            padding: 0.0,
            position_offset: [0.0; 3],
            position_padding: 0.0,
            reserved: [0.0; 12],
        }
    }

    #[test]
    fn empty_scene_has_no_native_storage_contract_instance() {
        assert_eq!(validate_record_count(0).unwrap(), 0);
    }

    #[test]
    fn storage_size_follows_96_byte_abi() {
        let packed = pack_records(&[sample(), sample()]).unwrap();
        assert_eq!(packed.len(), 2 * PROBE_GI_RECORD_BYTES);
        assert_eq!(PROBE_GI_STORAGE_MIN_BINDING_BYTES, 96);
    }

    #[test]
    fn invalid_record_never_reaches_storage() {
        let mut invalid = sample();
        invalid.validity = f32::NAN;
        assert!(matches!(
            pack_records(&[invalid]),
            Err(ProbeGiAbiError::InvalidRecord)
        ));
    }
}
