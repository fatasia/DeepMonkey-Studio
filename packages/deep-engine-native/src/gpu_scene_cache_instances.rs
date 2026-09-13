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
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Deep Engine native incremental packed instances"),
        size: u64::try_from(count).unwrap() * PACKED_INSTANCE_BYTES,
        usage: wgpu::BufferUsages::VERTEX
            | wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut transfer = InstanceTransfer::default();
    if packed.is_empty() {
        queue.write_buffer(&buffer, 0, cast_slice(&[[0.0_f32; PACKED_INSTANCE_FLOATS]]));
        transfer.uploaded_bytes = PACKED_INSTANCE_BYTES;
    } else {
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
                command.copy_buffer_to_buffer(&previous.buffer, offset, &buffer, offset, bytes);
                transfer.copied_bytes += bytes;
            } else {
                queue.write_buffer(&buffer, offset, cast_slice(&packed[start..index]));
                transfer.uploaded_bytes += bytes;
            }
        }
        if let Some(encoder) = encoder {
            queue.submit([encoder.finish()]);
        }
    }
    (
        Arc::new(GpuInstanceResource {
            buffer,
            packed: packed.to_vec(),
        }),
        transfer,
    )
}
