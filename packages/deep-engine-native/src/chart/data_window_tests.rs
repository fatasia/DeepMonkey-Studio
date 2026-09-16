use super::*;

#[test]
fn append_chunks_and_visible_slices_stay_contiguous() {
    let mut series = ChunkedSeries {
        chunk_size: 4,
        chunks: Vec::new(),
        total_len: 0,
    };
    series
        .append(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0])
        .expect("append");
    assert_eq!(series.len(), 6);
    assert_eq!(series.chunks.len(), 2, "4-point chunks: [0..4) and [4..6)");
    assert_eq!(series.visible_slice(2, 5), vec![2.0, 3.0, 4.0]);
    assert!(
        series.visible_slice(5, 2).is_empty(),
        "reversed range is empty"
    );
}

#[test]
fn resident_budget_fails_closed_over_one_million_points() {
    let mut series = ChunkedSeries {
        chunk_size: CHUNK_SIZE,
        chunks: Vec::new(),
        total_len: 0,
    };
    let error = series
        .append(&vec![0.0; MAX_RESIDENT_POINTS + 1])
        .unwrap_err();
    assert_eq!(
        error,
        ChannelError::BudgetExceeded {
            requested: MAX_RESIDENT_POINTS + 1,
            cap: MAX_RESIDENT_POINTS,
        }
    );
    assert!(series.is_empty(), "failed append must not partially land");
}

#[test]
fn decimation_keeps_first_last_and_reports_drops() {
    let series = ChunkedSeries {
        chunk_size: CHUNK_SIZE,
        chunks: vec![SeriesChunk {
            start: 0,
            values: (0..100).map(|i| i as f64).collect(),
        }],
        total_len: 100,
    };
    let visible = series.visible_slice(0, 100);
    let (drawn, accounting) = series.decimate(&visible, 10);
    assert_eq!(drawn.len(), 10);
    assert_eq!(drawn[0], 0.0, "first sample survives");
    assert_eq!(
        *drawn.last().expect("non-empty"),
        99.0,
        "last sample survives"
    );
    assert_eq!(accounting.drawn_points, 10);
    assert_eq!(accounting.dropped_points, 90);
    assert_eq!(accounting.decimation, Decimation::EqualStrideFirstLast);

    // Below budget: no decimation, no drops.
    let (drawn, accounting) = series.decimate(&visible, 100);
    assert_eq!(drawn.len(), 100);
    assert_eq!(accounting.decimation, Decimation::None);
    assert_eq!(accounting.dropped_points, 0);
}

#[test]
fn evict_range_frees_whole_chunks_and_keeps_indices_stable() {
    let mut series = ChunkedSeries {
        chunk_size: 4,
        chunks: Vec::new(),
        total_len: 0,
    };
    series
        .append(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0])
        .expect("append");
    let freed = series.evict_range(4, 8);
    assert_eq!(freed, 4, "only the second chunk frees");
    assert_eq!(series.len(), 8, "logical length is unchanged by eviction");
    let freed = series.evict_range(0, 100);
    assert_eq!(freed, 4, "the first chunk still holds its data");
}

#[test]
fn append_after_eviction_preserves_logical_positions() {
    let mut series = ChunkedSeries::with_chunk_size(4);
    series
        .append(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0])
        .expect("append");
    assert_eq!(series.evict_range(0, 4), 4);
    series.append(&[6.0, 7.0]).expect("append after page-out");
    assert_eq!(series.len(), 8);
    assert_eq!(series.visible_slice(0, 8), vec![4.0, 5.0, 6.0, 7.0]);
}
