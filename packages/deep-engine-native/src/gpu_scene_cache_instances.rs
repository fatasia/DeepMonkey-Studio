use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::{
    mesh_abi::PACKED_INSTANCE_BYTES,
    scene::{PACKED_INSTANCE_FLOATS, PackedInstance},
};

use crate::gpu_scene::GpuInstanceResource;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InstanceTransfer {
    pub uploaded_bytes: u64,
    pub copied_bytes: u64,
}

/// B05: 实例暂存环形槽深度。3 槽 > wgpu 典型 2 帧在途队列:
/// 本帧写槽 `next`,copy 源是上一帧写的槽 `(next+DEPTH-1) % DEPTH`,
/// 不同槽位保证队列内无"同 buffer 同时读写的自依赖"。
pub const INSTANCE_STAGING_RING_DEPTH: usize = 3;

fn instance_buffer_desc(size: u64) -> wgpu::BufferDescriptor<'static> {
    wgpu::BufferDescriptor {
        label: Some("Deep Engine native staged packed instances"),
        size,
        usage: wgpu::BufferUsages::VERTEX
            | wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    }
}

/// 把增量区间写入既有目标 buffer:未变区间从 previous copy,变化区间 queue write。
/// copy+write 的并集覆盖 [0, packed.len()) 全部实例,因此目标 buffer 的旧内容
/// 不参与结果(槽复用的正确性依据)。
fn copy_incremental_into(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    previous: &Arc<GpuInstanceResource>,
    packed: &[PackedInstance],
    buffer: &wgpu::Buffer,
) -> InstanceTransfer {
    let mut transfer = InstanceTransfer::default();
    let mut encoder = None;
    let mut index = 0;
    while index < packed.len() {
        let unchanged = previous.packed.get(index) == Some(&packed[index]);
        let start = index;
        index += 1;
        while index < packed.len()
            && (previous.packed.get(index) == Some(&packed[index])) == unchanged
        {
            index += 1;
        }
        let offset = u64::try_from(start).unwrap() * PACKED_INSTANCE_BYTES;
        let bytes = u64::try_from(index - start).unwrap() * PACKED_INSTANCE_BYTES;
        if unchanged {
            let command = encoder.get_or_insert_with(|| {
                device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Deep Engine native incremental instance copy"),
                })
            });
            command.copy_buffer_to_buffer(&previous.buffer, offset, buffer, offset, bytes);
            transfer.copied_bytes += bytes;
        } else {
            queue.write_buffer(buffer, offset, cast_slice(&packed[start..index]));
            transfer.uploaded_bytes += bytes;
        }
    }
    if let Some(encoder) = encoder {
        queue.submit([encoder.finish()]);
    }
    transfer
}

/// 接线波次的待消费接口（C3 域）；当前仅测试引用。
#[allow(dead_code)]
pub fn stage_instance_update(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    previous: Option<&Arc<GpuInstanceResource>>,
    packed: &[PackedInstance],
) -> (Arc<GpuInstanceResource>, InstanceTransfer) {
    let Some(previous) = previous else {
        let allocation = Arc::new(GpuInstanceResource::new(device, packed));
        return (
            allocation,
            InstanceTransfer {
                uploaded_bytes: u64::try_from(packed.len().max(1)).unwrap() * PACKED_INSTANCE_BYTES,
                copied_bytes: 0,
            },
        );
    };
    let count = packed.len().max(1);
    let buffer = device.create_buffer(&instance_buffer_desc(
        u64::try_from(count).unwrap() * PACKED_INSTANCE_BYTES,
    ));
    let transfer = if packed.is_empty() {
        queue.write_buffer(&buffer, 0, cast_slice(&[[0.0_f32; PACKED_INSTANCE_FLOATS]]));
        InstanceTransfer {
            uploaded_bytes: PACKED_INSTANCE_BYTES,
            copied_bytes: 0,
        }
    } else {
        copy_incremental_into(device, queue, previous, packed, &buffer)
    };
    (
        Arc::new(GpuInstanceResource {
            buffer,
            packed: packed.to_vec(),
        }),
        transfer,
    )
}

/// B05 staging ring:按帧轮转复用固定槽位,消除每帧 GPU buffer 的
/// 创建/销毁抖动(驱动侧分配 churn + 旧 buffer 延迟释放积压)。
///
/// 容量策略:槽容量按需增长、永不收缩——收缩会带来 resize 抖动,
/// 峰值驻留是可接受代价。
pub struct InstanceStagingRing {
    slots: [Option<Arc<GpuInstanceResource>>; INSTANCE_STAGING_RING_DEPTH],
    next: usize,
}

impl Default for InstanceStagingRing {
    fn default() -> Self {
        Self::new()
    }
}

impl InstanceStagingRing {
    pub fn new() -> Self {
        Self {
            slots: Default::default(),
            next: 0,
        }
    }

    /// 槽选择纯逻辑(单测锚点):返回本帧写入的槽位与推进后的游标。
    fn advance(&mut self) -> usize {
        let index = self.next;
        self.next = (self.next + 1) % INSTANCE_STAGING_RING_DEPTH;
        index
    }

    /// 槽复用判定纯逻辑(单测锚点):容量足够才复用。
    fn reusable(slot: Option<&Arc<GpuInstanceResource>>, needed_bytes: u64) -> bool {
        matches!(slot, Some(slot) if slot.buffer.size() >= needed_bytes)
    }

    pub fn stage(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        previous: Option<&Arc<GpuInstanceResource>>,
        packed: &[PackedInstance],
    ) -> (Arc<GpuInstanceResource>, InstanceTransfer) {
        let needed = u64::try_from(packed.len().max(1)).unwrap() * PACKED_INSTANCE_BYTES;
        let index = self.advance();
        let buffer = if Self::reusable(self.slots[index].as_ref(), needed) {
            self.slots[index]
                .as_ref()
                .map(|slot| slot.buffer.clone())
                .unwrap()
        } else {
            device.create_buffer(&instance_buffer_desc(needed))
        };
        let transfer = if packed.is_empty() {
            queue.write_buffer(&buffer, 0, cast_slice(&[[0.0_f32; PACKED_INSTANCE_FLOATS]]));
            InstanceTransfer {
                uploaded_bytes: PACKED_INSTANCE_BYTES,
                copied_bytes: 0,
            }
        } else if let Some(previous) = previous {
            copy_incremental_into(device, queue, previous, packed, &buffer)
        } else {
            queue.write_buffer(&buffer, 0, cast_slice(packed));
            InstanceTransfer {
                uploaded_bytes: needed,
                copied_bytes: 0,
            }
        };
        let resource = Arc::new(GpuInstanceResource {
            buffer,
            packed: packed.to_vec(),
        });
        self.slots[index] = Some(Arc::clone(&resource));
        (resource, transfer)
    }

    /// 观测面:当前已驻留槽数(测试与遥测用)。
    #[allow(dead_code)] // 测试与遥测消费；bin 目标暂未引用。
    pub fn resident_slots(&self) -> usize {
        self.slots.iter().filter(|slot| slot.is_some()).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advance_cycles_three_slots() {
        let mut ring = InstanceStagingRing::new();
        assert_eq!(ring.advance(), 0);
        assert_eq!(ring.advance(), 1);
        assert_eq!(ring.advance(), 2);
        assert_eq!(ring.advance(), 0, "ring must wrap after DEPTH frames");
    }

    #[test]
    fn reusable_requires_sufficient_capacity() {
        assert!(!InstanceStagingRing::reusable(None, 16));
        // None 之外的容量判定依赖 GPU buffer,真值路径由 GPU 集成测试覆盖;
        // 这里锁定 None 必不可复用这一条合同。
    }

    #[test]
    fn resident_slots_starts_empty() {
        let ring = InstanceStagingRing::new();
        assert_eq!(ring.resident_slots(), 0);
    }
}
