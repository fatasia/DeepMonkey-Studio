//! F3 Native GI 探针存储与绑定合同。
//!
//! 该模块只负责把已验证的 96B 探针记录拥有化为 Native storage buffer，
//! 不改变既有 IBL frame layout，也不宣称已经接入着色器采样。

// 绑定合同先行落库:着色采样消费方在后续切片接入,窄特性目标只驱动
// 拥有化/绑定合同,故模块级放行 dead_code。
#![allow(dead_code)]

use crate::probe_gi_abi::{
    IrradianceProbeRecord, PROBE_GI_RECORD_BYTES, ProbeGiAbiError, pack_records,
    validate_record_count,
};

pub const PROBE_GI_STORAGE_BINDING: u32 = 0;
pub const PROBE_GI_STORAGE_MIN_BINDING_BYTES: u64 = PROBE_GI_RECORD_BYTES as u64;

/// frame layout 上的探针 storage 槽号;0..10 既有绑定（frame uniform、
/// 阴影/IBL 纹理、IES、RT TLAS）保持不动,本槽只追加在末尾。
pub const FRAME_PROBE_GI_BINDING: u32 = 11;
/// frame uniform 保留开关通道:lightDirection 行（row 11）的 w 分位。
/// 既有写入方只覆盖 `frame[11][..3]`,所有 shader 从不读取该分位,
/// 旧包恒为 0 = 探针 GI 关闭,旧行为逐位不变。
pub const FRAME_PROBE_GI_ENABLE_ROW: usize = 11;
pub const FRAME_PROBE_GI_ENABLE_LANE: usize = 3;

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
// layout/bind_group/record_count/byte_len 是绑定合同驻留状态;窄特性目标
// 只走 buffer() 读路径,完整目标经访问器消费。
#[allow(dead_code)]
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
        Self::from_packed(device, packed, records.len()).map(Some)
    }

    /// 用已通过合同校验的打包字节创建 storage。网格三线性模式必须走本入口：
    /// 网格头记录（padding=baseProbeRecords、v2 布局头合法占用保留区）不在
    /// `pack_records` 的逐记录 ABI 校验范围内，其结构由 `probe_gi_grid`
    /// 级联 decode 合同先行校验（见 `pack_cascade_records`）。
    pub fn from_packed(
        device: &wgpu::Device,
        packed: Vec<u8>,
        record_count: usize,
    ) -> Result<Self, ProbeGiStorageError> {
        if packed.is_empty() {
            validate_record_count(0)?;
            return Err(ProbeGiStorageError::DeviceLimitExceeded);
        }
        let byte_len =
            u64::try_from(packed.len()).map_err(|_| ProbeGiStorageError::DeviceLimitExceeded)?;
        if byte_len < PROBE_GI_STORAGE_MIN_BINDING_BYTES
            || byte_len > device.limits().max_storage_buffer_binding_size
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
        Ok(Self {
            buffer,
            layout,
            bind_group,
            record_count,
            byte_len,
        })
    }

    pub fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }
    #[allow(dead_code)] // 绑定合同访问器:窄特性目标只消费 buffer()。
    pub fn layout(&self) -> &wgpu::BindGroupLayout {
        &self.layout
    }
    #[allow(dead_code)]
    pub fn bind_group(&self) -> &wgpu::BindGroup {
        &self.bind_group
    }
    #[allow(dead_code)]
    pub fn record_count(&self) -> usize {
        self.record_count
    }
    #[allow(dead_code)]
    pub fn byte_len(&self) -> u64 {
        self.byte_len
    }
}

/// frame layout binding 11 的全零占位 buffer（恰好一条 96B 记录,
/// validity = 0）。空场景/旧包没有真实探针,但 wgpu bind group 必须填满
/// layout 全部条目,因此用该占位满足绑定;frame 开关为 0 时采样分支
/// 直接返回零,视觉与旧路径逐位一致。
pub fn disabled_frame_buffer(device: &wgpu::Device) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Deep Engine native probe GI disabled placeholder"),
        contents: &[0u8; PROBE_GI_RECORD_BYTES],
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
    })
}

/// 解析 frame 绑定应使用的探针 storage:有真实探针用真实 buffer,
/// 否则用占位。占位由调用方持有,生命周期覆盖所有引用它的 bind group。
pub fn frame_probe_buffer<'a>(
    storage: Option<&'a ProbeGiStorage>,
    disabled: &'a wgpu::Buffer,
) -> &'a wgpu::Buffer {
    storage.map_or(disabled, |storage| storage.buffer())
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

    #[test]
    fn frame_slot_binding_keeps_existing_range_intact() {
        // 0..10 是既有 frame/RT 绑定;探针槽只允许追加在 11。
        assert_eq!(FRAME_PROBE_GI_BINDING, 11);
        assert_eq!(FRAME_PROBE_GI_ENABLE_ROW, 11);
        assert_eq!(FRAME_PROBE_GI_ENABLE_LANE, 3);
    }

    #[test]
    fn disabled_placeholder_is_one_zero_record() {
        // 占位即一条全零记录:满足 layout min binding 96B,validity=0
        // 让采样即使被误开也返回零,不产生光照差异。
        assert_eq!(PROBE_GI_STORAGE_MIN_BINDING_BYTES, 96);
        assert_eq!(IrradianceProbeRecord::zero().validity, 0.0);
    }
}
