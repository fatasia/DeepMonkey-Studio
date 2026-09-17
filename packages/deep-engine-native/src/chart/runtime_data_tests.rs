//! P1-03 接线测试:AppendWindow 数据通道经 `ChunkedRows` 镜像后的镜像一致性、
//! 克隆 Arc 块共享引用计数与失败路径零污染。黑盒全链一致性见
//! `tests/chart_data_update.rs`。
use crate::chart::chunked_rows::ChunkedRows;
use crate::chart::{
    ChartDataUpdate, ChartDataset, ChartRuntime, DatasetRowsUpdate, parse_chart_ir,
};
use serde_json::json;

fn runtime() -> ChartRuntime {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.datasets.push(ChartDataset {
        id: "unused".into(),
        dimensions: vec!["v".into()],
        rows: vec![vec![json!(1)]].into(),
    });
    ChartRuntime::new(ir, 216.0, 216.0).unwrap()
}

fn command(r: &ChartRuntime, datasets: Vec<DatasetRowsUpdate>) -> ChartDataUpdate {
    ChartDataUpdate {
        expected_data_revision: r.data_revision(),
        data_revision: r.data_revision() + 1,
        datasets,
    }
}

fn append(id: &str, rows: Vec<Vec<serde_json::Value>>, max_rows: usize) -> DatasetRowsUpdate {
    DatasetRowsUpdate::AppendWindow {
        dataset_id: id.into(),
        rows,
        max_rows,
    }
}

fn numbered_rows(count: usize, seed: f64) -> Vec<Vec<serde_json::Value>> {
    (0..count)
        .map(|index| vec![json!(seed + index as f64)])
        .collect()
}

/// 未分块参考实现:整段拼接后保留最后 `limit` 行(接线前的手写窗口语义)。
fn unchunked_window(
    old: &[Vec<serde_json::Value>],
    incoming: Vec<Vec<serde_json::Value>>,
    limit: usize,
) -> Vec<Vec<serde_json::Value>> {
    let dropped = (old.len() + incoming.len()).saturating_sub(limit);
    let mut rows: Vec<_> = old.iter().skip(dropped).cloned().collect();
    rows.extend(incoming.into_iter().skip(dropped.saturating_sub(old.len())));
    rows
}

fn assert_mirror_matches_source(runtime: &ChartRuntime, dataset_id: &str) {
    let index = runtime
        .source
        .datasets
        .iter()
        .position(|dataset| dataset.id == dataset_id)
        .unwrap();
    let mirror = &runtime.data_windows[dataset_id];
    assert_eq!(
        mirror.resident_rows(),
        runtime.source.datasets[index].rows.len(),
        "mirror residency must equal committed ChartIR rows"
    );
    for (mirror_row, source_row) in mirror
        .iter()
        .zip(runtime.source.datasets[index].rows.iter())
    {
        assert_eq!(mirror_row, source_row);
    }
}

#[test]
fn append_window_builds_chunked_mirror_matching_committed_rows() {
    let mut current = runtime();
    current
        .update_data(command(
            &current,
            vec![append("unused", numbered_rows(5, 1.0), 4)],
        ))
        .unwrap();
    assert!(current.data_windows.contains_key("unused"));
    assert_eq!(current.data_windows["unused"].resident_rows(), 4);
    assert!(current.data_windows["unused"].chunk_count() >= 1);
    assert_mirror_matches_source(&current, "unused");
    // 未触碰窗口语义的数据集不产生镜像。
    assert!(!current.data_windows.contains_key("main"));
}

#[test]
fn runtime_clone_shares_window_chunks_and_eviction_keeps_old_snapshot_intact() {
    // 20_000 行切成 3 块(8_192+8_192+3_616),保证滚动窗口只动首块、
    // 尾部块有可观测的跨实例共享。
    let mut current = runtime();
    current
        .update_data(command(
            &current,
            vec![append("unused", numbered_rows(20_000, 0.0), 20_000)],
        ))
        .unwrap();
    assert_eq!(current.data_windows["unused"].chunk_count(), 3);
    let counts_before = current.data_windows["unused"].chunk_strong_counts();
    let snapshot = current.clone();
    let counts_after = snapshot.data_windows["unused"].chunk_strong_counts();
    // 克隆后每个行块引用计数 +1:两窗口共享全部块,零复制。
    assert_eq!(
        counts_after,
        counts_before
            .iter()
            .map(|count| count + 1)
            .collect::<Vec<_>>()
    );
    // 原 runtime 小步滚动窗口:仅首块写时复制收缩,尾部两块继续共享。
    current
        .update_data(command(
            &current,
            vec![append("unused", numbered_rows(1_000, 100_000.0), 20_000)],
        ))
        .unwrap();
    assert_mirror_matches_source(&current, "unused");
    assert_mirror_matches_source(&snapshot, "unused");
    // 快照驻留与首行内容保持更新前状态。
    assert_eq!(snapshot.data_windows["unused"].resident_rows(), 20_000);
    let snapshot_first = snapshot.data_windows["unused"].iter().next().unwrap()[0]
        .as_f64()
        .unwrap();
    assert_eq!(snapshot_first, 0.0);
    let counts_current = current.data_windows["unused"].chunk_strong_counts();
    // 分离后的新首块独占、新追加块独占;被保留的两块旧行块仍被两个窗口
    // 共享(引用计数 ≥2 即 Arc 共存证据)。
    assert_eq!(counts_current[0], 1);
    assert_eq!(*counts_current.last().unwrap(), 1);
    assert!(
        counts_current[1..counts_current.len() - 1]
            .iter()
            .all(|count| *count >= 2)
    );
}

#[test]
fn cross_chunk_window_matches_unchunked_reference_value_by_value() {
    let mut current = runtime();
    current
        .update_data(command(
            &current,
            vec![append("unused", numbered_rows(9_000, 0.0), 9_000)],
        ))
        .unwrap();
    let mut expected = numbered_rows(9_000, 0.0);
    let mut resident: Vec<Vec<serde_json::Value>> = expected.clone();
    // 窗口 10_000 与 ROWS_PER_CHUNK=8_192 错位:追加后触发首块中间收缩。
    for round in 1..=3 {
        let incoming = numbered_rows(3_500, round as f64 * 10_000.0);
        expected = unchunked_window(&resident, incoming.clone(), 10_000);
        current
            .update_data(command(&current, vec![append("unused", incoming, 10_000)]))
            .unwrap();
        resident = expected.clone();
        let committed = &current
            .source
            .datasets
            .iter()
            .find(|dataset| dataset.id == "unused")
            .unwrap()
            .rows;
        assert_eq!(committed.len(), 10_000);
        for (committed_row, expected_row) in committed.iter().zip(&expected) {
            assert_eq!(committed_row, expected_row);
        }
        assert_mirror_matches_source(&current, "unused");
    }
    let _ = expected; // expected 与 resident 同步演进,仅供参考实现复用
}

#[test]
fn failed_batch_leaves_window_mirror_untouched() {
    let mut current = runtime();
    current
        .update_data(command(
            &current,
            vec![append("unused", numbered_rows(3, 1.0), 3)],
        ))
        .unwrap();
    let mirror_before = current.data_windows["unused"].clone();
    let source_before = current.source.clone();
    // 同批首条 AppendWindow 已在局部推进,但同批未知数据集使整条命令失败:
    // 暂存的窗口变更不得落地。
    assert!(
        current
            .update_data(command(
                &current,
                vec![append("unused", numbered_rows(2, 50.0), 3)]
                    .into_iter()
                    .chain(std::iter::once(DatasetRowsUpdate::Replace {
                        dataset_id: "missing".into(),
                        rows: vec![],
                    }))
                    .collect(),
            ))
            .is_err()
    );
    assert!(current.data_windows["unused"].shares_chunk_storage_with(&mirror_before));
    assert!(std::ptr::eq(
        std::sync::Arc::as_ptr(&current.source),
        std::sync::Arc::as_ptr(&source_before)
    ));
    assert_mirror_matches_source(&current, "unused");
    // 坏行批次同样不落镜像。
    assert!(
        current
            .update_data(command(
                &current,
                vec![append("unused", vec![vec![json!({"bad": true})]], 3)]
            ))
            .is_err()
    );
    assert!(current.data_windows["unused"].shares_chunk_storage_with(&mirror_before));
    assert_mirror_matches_source(&current, "unused");
}

#[test]
fn replace_clears_window_mirror_and_rebuilds_on_next_append() {
    let mut current = runtime();
    current
        .update_data(command(
            &current,
            vec![append("unused", numbered_rows(3, 1.0), 3)],
        ))
        .unwrap();
    assert!(current.data_windows.contains_key("unused"));
    current
        .update_data(command(
            &current,
            vec![DatasetRowsUpdate::Replace {
                dataset_id: "unused".into(),
                rows: numbered_rows(2, 9.0),
            }],
        ))
        .unwrap();
    assert!(!current.data_windows.contains_key("unused"));
    current
        .update_data(command(
            &current,
            vec![append("unused", numbered_rows(2, 20.0), 3)],
        ))
        .unwrap();
    assert_mirror_matches_source(&current, "unused");
    // total = 2(replaced)+2(incoming) = 4,窗口 3 → 淘汰 replaced 首行(9.0),
    // 镜像从替换后的行重建而非旧窗口。
    let first = current.data_windows["unused"].iter().next().unwrap()[0]
        .as_f64()
        .unwrap();
    assert_eq!(first, 10.0);
}

#[test]
fn empty_append_evicts_old_rows_through_chunked_mirror() {
    let mut current = runtime();
    // 空批次且驻留未超窗:与接线前一致,短路为无语义变化(不建镜像)。
    current
        .update_data(command(&current, vec![append("unused", vec![], 1)]))
        .unwrap();
    assert!(!current.data_windows.contains_key("unused"));
    // 先建 3 行镜像,再以空批次缩窗到 1:经分块镜像淘汰旧行。
    current
        .update_data(command(
            &current,
            vec![append("unused", numbered_rows(3, 1.0), 3)],
        ))
        .unwrap();
    current
        .update_data(command(&current, vec![append("unused", vec![], 1)]))
        .unwrap();
    assert_eq!(current.data_windows["unused"].resident_rows(), 1);
    assert_mirror_matches_source(&current, "unused");
    let committed = current
        .source
        .datasets
        .iter()
        .find(|dataset| dataset.id == "unused")
        .unwrap();
    assert_eq!(committed.rows.len(), 1);
}

#[test]
fn oversized_incoming_batch_fails_closed_before_mirror_append() {
    let mut current = runtime();
    let oversized = numbered_rows(crate::chart::CHART_BUDGETS.rows + 1, 0.0);
    let error = current
        .update_data(command(&current, vec![append("unused", oversized, 4)]))
        .unwrap_err();
    assert!(error.contains("budget"), "unexpected error: {error}");
    assert!(!current.data_windows.contains_key("unused"));
    assert_mirror_absent_or_consistent(&current);
}

fn assert_mirror_absent_or_consistent(current: &ChartRuntime) {
    for dataset in &current.source.datasets {
        if let Some(mirror) = current.data_windows.get(&dataset.id) {
            assert_eq!(mirror.resident_rows(), dataset.rows.len());
        }
    }
}

/// 存储层类型在本模块的可用性哨兵:窗口镜像必须是分块容器而非裸 Vec。
#[test]
fn mirror_is_chunked_rows_container() {
    let mirror = ChunkedRows::from_rows(vec![vec![json!(1)], vec![json!(2)]]).unwrap();
    assert_eq!(mirror.chunk_count(), 1);
    assert_eq!(mirror.head_start(), 0);
}
