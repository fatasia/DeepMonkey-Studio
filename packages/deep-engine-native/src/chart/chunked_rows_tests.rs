use super::*;
use serde_json::json;

fn row(index: usize) -> Vec<ChartValue> {
    // 混合语义:分类/中文/数值/null 同行共存。
    vec![
        json!(format!("设备-{index}")),
        json!(if index.is_multiple_of(3) {
            "运行"
        } else {
            "备用"
        }),
        json!(index),
        json!(index as f64 * 0.5),
        json!(if index.is_multiple_of(7) {
            serde_json::Value::Null
        } else {
            json!("中文标签")
        }),
    ]
}

fn mixed_rows(count: usize) -> Vec<Vec<ChartValue>> {
    (0..count).map(row).collect()
}

#[test]
fn mixed_value_semantics_survive_chunking_and_iteration() {
    let rows = ChunkedRows::from_rows(mixed_rows(20)).unwrap();
    assert_eq!(rows.resident_rows(), 20);
    assert_eq!(rows.chunk_count(), 1);
    let collected: Vec<_> = rows.iter().collect();
    assert_eq!(collected.len(), 20);
    assert_eq!(collected[0][1], json!("运行"));
    assert_eq!(collected[7][4], serde_json::Value::Null);
    assert_eq!(collected[19][0], json!("设备-19"));
}

#[test]
fn clone_shares_all_chunks_and_only_detached_chunk_copies_on_write() {
    let mut rows = ChunkedRows::from_rows(mixed_rows(20_000)).unwrap();
    let snapshot = rows.clone();
    assert!(rows.shares_chunk_storage_with(&snapshot));
    let before = snapshot.chunk_strong_counts();
    assert!(before.iter().all(|count| *count == 2));
    // 窗口 20000 内追加 10 行:首块被局部收缩(写时复制分离),其余块仍共享。
    rows.append_window(mixed_rows(10), 20_000).unwrap();
    let after = snapshot.chunk_strong_counts();
    assert_eq!(after[0], 1, "首块经写时复制与快照分离");
    assert_eq!((after[1], after[2]), (2, 2), "未变的块引用计数不变");
}

#[test]
fn window_eviction_drops_whole_chunks_and_old_snapshot_keeps_its_rows() {
    let mut rows = ChunkedRows::from_rows(mixed_rows(20_000)).unwrap();
    let snapshot = rows.clone();
    rows.append_window(mixed_rows(16_000), 20_000).unwrap();
    assert_eq!(rows.resident_rows(), 20_000);
    assert_eq!(rows.head_start(), 16_000);
    assert!(rows.chunk_count() < snapshot.chunk_count() + 2);
    // 旧快照仍可完整遍历自己的 20000 行,块未被释放(Arc 持有)。
    assert_eq!(snapshot.resident_rows(), 20_000);
    assert_eq!(snapshot.iter().count(), 20_000);
    assert_eq!(snapshot.iter().next().unwrap()[0], json!("设备-0"));
    // 新容器的第一行是绝对行号 16000。
    assert_eq!(rows.iter().next().unwrap()[0], json!("设备-16000"));
}

#[test]
fn partial_window_boundary_copies_only_the_front_chunk() {
    let mut rows = ChunkedRows::from_rows(mixed_rows(20_000)).unwrap();
    let snapshot = rows.clone();
    // 窗口 18000:整块淘汰后边界落在首块中间,首块写时复制收缩。
    rows.append_window(mixed_rows(9_000), 18_000).unwrap();
    assert_eq!(rows.resident_rows(), 18_000);
    let counts = rows.chunk_strong_counts();
    // 收缩后的首块已与旧快照分离(计数 1);原第三块仍共享(计数 2);新块计数 1。
    assert_eq!(counts[0], 1, "front chunk must detach");
    assert_eq!(counts[1], 2, "untouched original chunk stays shared");
    assert!(
        counts[2..].iter().all(|count| *count == 1),
        "fresh chunks are exclusively owned"
    );
    assert_eq!(snapshot.iter().count(), 20_000);
    assert_eq!(rows.iter().next().unwrap()[0], json!("设备-11000"));
}

#[test]
fn budget_fails_closed_without_silent_eviction_on_construction() {
    assert_eq!(
        ChunkedRows::with_budget(mixed_rows(25_000), 20_000),
        Err(ChunkedRowsError::BudgetExceeded {
            requested: 25_000,
            cap: 20_000
        })
    );
    let empty = ChunkedRows::from_rows(vec![]).unwrap();
    assert_eq!(empty.resident_rows(), 0);
    let mut rows = ChunkedRows::with_budget(mixed_rows(1_000), 1_000).unwrap();
    assert_eq!(
        rows.append_window(mixed_rows(2_000), 1_000),
        Err(ChunkedRowsError::BudgetExceeded {
            requested: 2_000,
            cap: 1_000
        })
    );
    // 含 null 值的单行是合法混合语义,原样入库。
    rows.append_window(vec![vec![serde_json::Value::Null]], 1_000)
        .unwrap();
    assert_eq!(rows.resident_rows(), 1_000);
    assert_eq!(rows.iter().last().unwrap()[0], serde_json::Value::Null);
}
