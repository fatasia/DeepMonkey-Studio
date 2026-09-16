use super::*;
use deep_engine_native::deep2d::{PreparedDeep2dPathChunk, PreparedDeep2dSummary};

fn prepared(parts: &[(usize, f32)]) -> PreparedDeep2d {
    let mut vertices = Vec::new();
    let mut chunks = Vec::new();
    for (index, (count, value)) in parts.iter().enumerate() {
        let first_vertex = vertices.len() as u32;
        vertices.extend(vec![[*value; 6]; *count]);
        chunks.push(PreparedDeep2dPathChunk {
            first_vertex,
            vertex_count: *count as u32,
            z_order: index as i32,
            source_index: index,
            clip_rect: None,
        });
    }
    let count = vertices.len();
    PreparedDeep2d {
        logical_width: 128.0,
        logical_height: 64.0,
        vertices,
        chunks,
        images: vec![],
        glyphs: vec![],
        summary: PreparedDeep2dSummary {
            commands: parts.len(),
            path_segments: 0,
            fill_triangles: count / 3,
            stroke_triangles: 0,
            vertices: count,
        },
    }
}
fn replay(previous: &VertexSnapshot, next: &PreparedDeep2d, transfers: &[Transfer]) {
    let old: &[u8] = bytemuck::cast_slice(&previous.vertices);
    let bytes: &[u8] = bytemuck::cast_slice(&next.vertices);
    let mut output = vec![0xff; bytes.len()];
    let mut expected_start = 0;
    for transfer in transfers {
        let (data, target) = match transfer {
            Transfer::Upload(target) => (&bytes[target.clone()], target),
            Transfer::Copy { source, target } => (&old[*source..*source + target.len()], target),
        };
        assert_eq!(target.start, expected_start);
        assert_eq!(target.start % 4, 0);
        assert_eq!(target.len() % 4, 0);
        output[target.clone()].copy_from_slice(data);
        expected_start = target.end;
    }
    assert_eq!(output, bytes);
    assert_eq!(expected_start, bytes.len());
}

#[test]
fn reorders_insertions_deletions_and_size_changes_reconstruct_exact_bytes() {
    let mut old = prepared(&[(3, 1.0), (6, 2.0), (3, 3.0)]);
    let snapshot = VertexSnapshot::capture(&mut old).unwrap();
    assert!(old.vertices.is_empty());
    assert_eq!(old.summary.vertices, 12);
    for parts in [
        vec![(3, 1.0), (6, 9.0), (3, 3.0)],
        vec![(3, 3.0), (3, 1.0)],
        vec![(6, 2.0), (3, 4.0), (3, 1.0), (3, 1.0)],
        vec![(9, 8.0), (3, 3.0)],
        vec![],
    ] {
        let next = prepared(&parts);
        let transfers = plan(&next, &snapshot).unwrap();
        replay(&snapshot, &next, &transfers);
    }
}

#[test]
fn adjacent_copies_and_uploads_are_coalesced_without_crossing_changes() {
    let mut old = prepared(&[(3, 1.0), (3, 2.0), (3, 3.0), (3, 4.0)]);
    let snapshot = VertexSnapshot::capture(&mut old).unwrap();
    let next = prepared(&[(3, 1.0), (3, 2.0), (3, 8.0), (3, 9.0)]);
    assert_eq!(
        plan(&next, &snapshot).unwrap(),
        vec![
            Transfer::Copy {
                source: 0,
                target: 0..144
            },
            Transfer::Upload(144..288)
        ]
    );
}

#[test]
fn fingerprint_matches_require_exact_byte_equality() {
    let mut old = prepared(&[(3, 1.0)]);
    let next = prepared(&[(3, 2.0)]);
    let mut snapshot = VertexSnapshot::capture(&mut old).unwrap();
    snapshot.regions[0].0 = content_key(bytemuck::cast_slice(&next.vertices));
    assert_eq!(
        plan(&next, &snapshot).unwrap(),
        vec![Transfer::Upload(0..72)]
    );
}

#[test]
fn invalid_ranges_and_shadow_budgets_fall_back_without_consuming_source() {
    let mut invalid = prepared(&[(3, 1.0)]);
    invalid.chunks[0].first_vertex = 1;
    assert!(VertexSnapshot::capture(&mut invalid).is_none());
    assert_eq!(invalid.vertices.len(), 3);
    let mut huge = prepared(&[(MAX_SHADOW_BYTES / STRIDE + 1, 0.0)]);
    assert!(VertexSnapshot::capture(&mut huge).is_none());
    assert!(!huge.vertices.is_empty());
    let mut many = prepared(&vec![(3, 0.0); MAX_REGIONS + 1]);
    assert!(VertexSnapshot::capture(&mut many).is_none());
}

#[test]
fn tiny_and_fragmented_copies_use_contiguous_uploads() {
    assert!(!use_copies(&[Transfer::Copy {
        source: 0,
        target: 0..MIN_COPY_BYTES - 1
    }]));
    assert!(use_copies(&[Transfer::Copy {
        source: 0,
        target: 0..MIN_COPY_BYTES
    }]));
    assert!(!use_copies(
        &(0..MAX_COPY_COMMANDS + 1)
            .map(|i| Transfer::Copy {
                source: i * 1024,
                target: i * 512..(i + 1) * 512
            })
            .collect::<Vec<_>>()
    ));
}

/// 归因判定顺序必须与 buffer_allocations 的事实一致:先判「为什么不能复制」,
/// 再判「复制成功但没达阈值」。若顺序写反,退化会被记成冷启动,账就失去意义。
#[test]
fn upload_reason_order_matches_the_allocations_fact() {
    use VertexTransferReason::*;
    assert_eq!(upload_reason(false, false, false), NoPreviousFrame);
    assert_eq!(upload_reason(false, true, true), NoPreviousFrame);
    assert_eq!(upload_reason(true, false, false), PreviousNotCopyable);
    assert_eq!(upload_reason(true, false, true), PreviousNotCopyable);
    assert_eq!(upload_reason(true, true, false), PlanRejected);
    assert_eq!(upload_reason(true, true, true), BelowCopyThreshold);
}

/// 每次 upload 恰好记一条原因,total() 恒等于 stage 次数——否则统计会双计或漏计。
#[test]
fn reasons_record_exactly_one_entry_per_upload() {
    let mut reasons = VertexTransferReasons::default();
    assert_eq!(reasons.total(), 0);
    for (index, reason) in [
        VertexTransferReason::ContentReused,
        VertexTransferReason::IncrementalCopies,
        VertexTransferReason::NoPreviousFrame,
        VertexTransferReason::PreviousNotCopyable,
        VertexTransferReason::PlanRejected,
        VertexTransferReason::BelowCopyThreshold,
    ]
    .into_iter()
    .enumerate()
    {
        reasons.record(reason);
        assert_eq!(reasons.total(), index as u64 + 1, "累计口径");
    }
    assert_eq!(reasons.content_reused, 1);
    assert_eq!(reasons.incremental_copies, 1);
    assert_eq!(reasons.no_previous_frame, 1);
    assert_eq!(reasons.previous_not_copyable, 1);
    assert_eq!(reasons.plan_rejected, 1);
    assert_eq!(reasons.below_copy_threshold, 1);
}
