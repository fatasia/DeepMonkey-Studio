//! 有界顶点快照、内容对照及连续传输区域规划。
use super::{MAX_COPY_COMMANDS, MAX_REGIONS, MAX_SHADOW_BYTES, MIN_COPY_BYTES, STRIDE};
use deep_engine_native::deep2d::PreparedDeep2d;
use std::{collections::HashMap, hash::Hasher, ops::Range};

pub(in super::super) struct VertexSnapshot {
    pub(super) vertices: Vec<[f32; 6]>,
    pub(super) regions: Vec<(u64, Range<usize>)>,
}
impl VertexSnapshot {
    pub(in super::super) fn capture(prepared: &mut PreparedDeep2d) -> Option<Self> {
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
pub(super) enum Transfer {
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

pub(super) fn plan(prepared: &PreparedDeep2d, previous: &VertexSnapshot) -> Option<Vec<Transfer>> {
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

pub(super) fn content_key(bytes: &[u8]) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    hash.write_u64(bytes.len() as u64);
    hash.write(bytes);
    hash.finish()
}

pub(super) fn use_copies(transfers: &[Transfer]) -> bool {
    let (bytes, commands) = transfers
        .iter()
        .fold((0, 0), |(bytes, commands), item| match item {
            Transfer::Copy { target, .. } => (bytes + target.len(), commands + 1),
            _ => (bytes, commands),
        });
    bytes >= MIN_COPY_BYTES && commands <= MAX_COPY_COMMANDS
}
