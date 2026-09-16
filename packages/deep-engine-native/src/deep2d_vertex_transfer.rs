//! 顶点内容对照只影响传输；不拆绘制批次，也不修改活动 GPU 缓冲。
use crate::deep2d_gpu_cache::Deep2dGpuAssetCache;
use deep_engine_native::deep2d::PreparedDeep2d;
use std::sync::Arc;
use wgpu::util::DeviceExt;

#[path = "deep2d_vertex_transfer_plan.rs"]
mod planning;
#[path = "deep2d_vertex_transfer_stats.rs"]
mod stats;
pub(super) use planning::VertexSnapshot;
use planning::{Transfer, content_key, plan, use_copies};
use stats::{VertexTransferReason, upload_reason};
pub use stats::{VertexTransferReasons, VertexTransferStats};

const MAX_SHADOW_BYTES: usize = 8 * 1024 * 1024;
const MAX_REGIONS: usize = 4096;
// 小缓冲直接上传，避免为几百字节节省多一次提交；碎片过多也退回连续上传。
const MIN_COPY_BYTES: usize = 16 * 1024;
const MAX_COPY_COMMANDS: usize = 64;
const STRIDE: usize = 24;

pub(super) fn upload(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    prepared: &PreparedDeep2d,
    cache: &Deep2dGpuAssetCache,
    previous: Option<(&wgpu::Buffer, &VertexSnapshot)>,
) -> (Arc<wgpu::Buffer>, VertexTransferStats) {
    let bytes: &[u8] = bytemuck::cast_slice(&prepared.vertices);
    let key = content_key(bytes);
    let mut stats = VertexTransferStats::default();
    if let Some(buffer) = cache.vertex_buffer(key, bytes.len()) {
        stats.reused_bytes = bytes.len();
        stats.reasons.record(VertexTransferReason::ContentReused);
        return (buffer, stats);
    }
    // 归因顺序固定:不可复制源 → 无前帧 → 区域对照被拒 → 未达阈值 → 增量成功。
    // 先判定「为什么不能复制」,最后才是「复制成功」,避免把失败路径记成成功。
    let copyable =
        previous.filter(|(buffer, _)| buffer.usage().contains(wgpu::BufferUsages::COPY_SRC));
    let transfers = copyable.and_then(|(_, snapshot)| plan(prepared, snapshot));
    // `use_copies` 只读判定,不消费 transfers——后面归因还要区分「被拒」与「未达阈值」。
    let use_incremental = transfers.as_ref().is_some_and(|items| use_copies(items));
    let buffer = if use_incremental {
        let transfers = transfers.expect("checked above");
        stats
            .reasons
            .record(VertexTransferReason::IncrementalCopies);
        stats.buffer_allocations = 1;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Deep2d candidate vertices"),
            size: bytes.len() as u64,
            usage: wgpu::BufferUsages::VERTEX
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Deep2d retained vertex copies"),
        });
        for transfer in transfers {
            match transfer {
                Transfer::Upload(target) => {
                    queue.write_buffer(&buffer, target.start as u64, &bytes[target.clone()]);
                    stats.uploaded_bytes += target.len();
                    stats.upload_regions += 1;
                }
                Transfer::Copy { source, target } => {
                    encoder.copy_buffer_to_buffer(
                        previous.unwrap().0,
                        source as u64,
                        &buffer,
                        target.start as u64,
                        target.len() as u64,
                    );
                    stats.copied_bytes += target.len();
                    stats.copy_regions += 1;
                }
            }
        }
        queue.submit([encoder.finish()]);
        buffer
    } else {
        stats.reasons.record(upload_reason(
            previous.is_some(),
            copyable.is_some(),
            transfers.is_some(),
        ));
        stats.buffer_allocations = 1;
        stats.uploaded_bytes = bytes.len();
        stats.upload_regions = usize::from(!bytes.is_empty());
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep2d initial vertices"),
            contents: bytes,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_SRC,
        })
    };
    let buffer = Arc::new(buffer);
    cache.store_vertex_buffer(key, bytes.len(), buffer.clone());
    (buffer, stats)
}

#[cfg(test)]
#[path = "deep2d_vertex_transfer_tests.rs"]
mod tests;
