//! 顶点内容对照只影响传输；不拆绘制批次，也不修改活动GPU缓冲。
use crate::deep2d_gpu_cache::Deep2dGpuAssetCache;
use deep_engine_native::deep2d::PreparedDeep2d;
use std::{collections::HashMap, hash::Hasher, ops::Range, sync::Arc};
use wgpu::util::DeviceExt;

const MAX_SHADOW_BYTES: usize = 8 * 1024 * 1024;
const MAX_REGIONS: usize = 4096;
// 小缓冲直接上传，避免为几百字节节省多一次提交；碎片过多也退回连续上传。
const MIN_COPY_BYTES: usize = 16 * 1024;
const MAX_COPY_COMMANDS: usize = 64;
const STRIDE: usize = 24;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VertexTransferStats {
    pub uploaded_bytes: usize,
    pub copied_bytes: usize,
    pub reused_bytes: usize,
    pub copy_regions: usize,
    pub upload_regions: usize,
    pub shadow_bytes: usize,
    /// 本次候选的 GPU 缓冲分配次数:0=整内容命中复用,1=新分配。
    /// 缓冲发布后不可变(旧帧只读的前提),因此每 stage 至多一次分配。
    pub buffer_allocations: usize,
    /// 未走增量复制的首要原因。计数是累积口径,与路径缓存的 miss 账分属两层:
    /// 缓存账回答「细分为什么重算」,本账回答「顶点为什么重传」。
    /// 二者交叉才能区分「几何没变但传输退化了」与「几何确实变了」。
    pub reasons: VertexTransferReasons,
}

/// 顶点传输的路径归因。判定顺序固定,与 buffer_allocations 的 0/1 事实一致。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct VertexTransferReasons {
    /// 内容寻址命中:整个缓冲逐字节复用,零传输零分配。
    pub content_reused: u64,
    /// 增量复制:命中前帧区域,只上传新增片段。
    pub incremental_copies: u64,
    /// 冷启动:没有前帧缓冲可对照。
    pub no_previous_frame: u64,
    /// 前帧缓冲不可作复制源(缺 COPY_SRC),只能整块上传。
    pub previous_not_copyable: u64,
    /// 有前帧但无法建立区域对照:超区域/字节上限或顶点不连续。
    pub plan_rejected: u64,
    /// 可复制但未达阈值(碎片多或小缓冲),整块上传更划算。
    pub below_copy_threshold: u64,
}

impl VertexTransferReasons {
    fn record(&mut self, reason: VertexTransferReason) {
        match reason {
            VertexTransferReason::ContentReused => self.content_reused += 1,
            VertexTransferReason::IncrementalCopies => self.incremental_copies += 1,
            VertexTransferReason::NoPreviousFrame => self.no_previous_frame += 1,
            VertexTransferReason::PreviousNotCopyable => self.previous_not_copyable += 1,
            VertexTransferReason::PlanRejected => self.plan_rejected += 1,
            VertexTransferReason::BelowCopyThreshold => self.below_copy_threshold += 1,
        }
    }
    /// 每次 upload 恰好记一条原因,因此恒等于 stage 次数。
    pub fn total(&self) -> u64 {
        self.content_reused
            + self.incremental_copies
            + self.no_previous_frame
            + self.previous_not_copyable
            + self.plan_rejected
            + self.below_copy_threshold
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VertexTransferReason {
    ContentReused,
    IncrementalCopies,
    NoPreviousFrame,
    PreviousNotCopyable,
    PlanRejected,
    BelowCopyThreshold,
}

/// 整块上传路径的归因判定(纯函数,便于锁定判定顺序而不依赖真实 GPU)。
/// 入参语义:`has_previous` 前帧是否存在;`copyable` 前帧是否可作复制源;
/// `planned` 区域对照是否成功。
fn upload_reason(
    has_previous: bool,
    copyable: bool,
    planned: bool,
) -> VertexTransferReason {
    match (has_previous, copyable, planned) {
        (false, _, _) => VertexTransferReason::NoPreviousFrame,
        (true, false, _) => VertexTransferReason::PreviousNotCopyable,
        // 有前帧且可复制,但区域对照被拒(超区域/字节上限/顶点不连续)。
        (true, true, false) => VertexTransferReason::PlanRejected,
        // 区域对照成功但碎片过多或缓冲太小,整块上传更划算。
        (true, true, true) => VertexTransferReason::BelowCopyThreshold,
    }
}

pub(super) struct VertexSnapshot {
    vertices: Vec<[f32; 6]>,
    regions: Vec<(u64, Range<usize>)>,
}
impl VertexSnapshot {
    pub(super) fn capture(prepared: &mut PreparedDeep2d) -> Option<Self> {
        if prepared.vertices.len() * STRIDE > MAX_SHADOW_BYTES
            || prepared.chunks.len() > MAX_REGIONS
        {
            return None;
        }
        let bytes: &[u8] = bytemuck::cast_slice(&prepared.vertices);
        let regions = ranges(prepared)?
            .into_iter()
            .map(|range| (content_key(&bytes[range.clone()]), range))
            .collect();
        Some(Self {
            vertices: std::mem::take(&mut prepared.vertices),
            regions,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Transfer {
    Upload(Range<usize>),
    Copy { source: usize, target: Range<usize> },
}

fn ranges(prepared: &PreparedDeep2d) -> Option<Vec<Range<usize>>> {
    let mut end = 0;
    let mut ranges = Vec::with_capacity(prepared.chunks.len());
    for chunk in &prepared.chunks {
        let start = chunk.first_vertex as usize * STRIDE;
        let next = start.checked_add(chunk.vertex_count as usize * STRIDE)?;
        if start != end || next > prepared.vertices.len() * STRIDE {
            return None;
        }
        if next > start {
            ranges.push(start..next);
        }
        end = next;
    }
    (end == prepared.vertices.len() * STRIDE).then_some(ranges)
}

fn plan(prepared: &PreparedDeep2d, previous: &VertexSnapshot) -> Option<Vec<Transfer>> {
    if prepared.chunks.len() > MAX_REGIONS || prepared.vertices.len() * STRIDE > MAX_SHADOW_BYTES {
        return None;
    }
    let bytes: &[u8] = bytemuck::cast_slice(&prepared.vertices);
    let old: &[u8] = bytemuck::cast_slice(&previous.vertices);
    let mut lookup: HashMap<(u64, usize), Vec<usize>> = HashMap::new();
    for (key, range) in &previous.regions {
        lookup
            .entry((*key, range.len()))
            .or_default()
            .push(range.start);
    }
    let mut transfers = Vec::new();
    for target in ranges(prepared)? {
        let data = &bytes[target.clone()];
        let source = lookup
            .get(&(content_key(data), data.len()))
            .and_then(|offsets| {
                offsets
                    .iter()
                    .copied()
                    .find(|offset| old.get(*offset..*offset + data.len()) == Some(data))
            });
        let transfer = match source {
            Some(source) => Transfer::Copy { source, target },
            None => Transfer::Upload(target),
        };
        append_transfer(&mut transfers, transfer);
    }
    Some(transfers)
}

fn append_transfer(transfers: &mut Vec<Transfer>, next: Transfer) {
    match (transfers.last_mut(), &next) {
        (Some(Transfer::Upload(previous)), Transfer::Upload(next))
            if previous.end == next.start =>
        {
            previous.end = next.end;
            return;
        }
        (
            Some(Transfer::Copy { source, target }),
            Transfer::Copy {
                source: next_source,
                target: next_target,
            },
        ) if target.end == next_target.start && *source + target.len() == *next_source => {
            target.end = next_target.end;
            return;
        }
        _ => {}
    }
    transfers.push(next);
}

fn content_key(bytes: &[u8]) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    hash.write_u64(bytes.len() as u64);
    hash.write(bytes);
    hash.finish()
}

fn use_copies(transfers: &[Transfer]) -> bool {
    let (bytes, commands) = transfers
        .iter()
        .fold((0, 0), |(bytes, commands), item| match item {
            Transfer::Copy { target, .. } => (bytes + target.len(), commands + 1),
            _ => (bytes, commands),
        });
    bytes >= MIN_COPY_BYTES && commands <= MAX_COPY_COMMANDS
}

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
    let copyable = previous.filter(|(buffer, _)| {
        buffer.usage().contains(wgpu::BufferUsages::COPY_SRC)
    });
    let transfers = copyable.and_then(|(_, snapshot)| plan(prepared, snapshot));
    // `use_copies` 只读判定,不消费 transfers——后面归因还要区分「被拒」与「未达阈值」。
    let use_incremental = transfers
        .as_ref()
        .is_some_and(|items| use_copies(items));
    let buffer = if use_incremental {
        let transfers = transfers.expect("checked above");
        stats.reasons.record(VertexTransferReason::IncrementalCopies);
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
