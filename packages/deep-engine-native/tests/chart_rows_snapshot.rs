#[path = "support/chart_rows_fixture.rs"]
mod chart_rows_fixture;
use chart_rows_fixture::{fixture, update};
use deep_engine_native::chart::{ChartRows, ChartRuntime, parse_chart_ir};
use serde_json::json;
use std::{hint::black_box, time::Instant};

#[test]
fn snapshot_clone_shares_all_datasets_and_nested_mutation_detaches_only_one() {
    let source = fixture(16);
    let mut next = source.clone();
    for (old, new) in source.datasets.iter().zip(&next.datasets) {
        assert!(old.rows.shares_storage_with(&new.rows));
    }
    next.datasets[0].rows[0][0] = json!("changed");
    assert_eq!(source.datasets[0].rows[0][0], "设备-0");
    assert!(
        !source.datasets[0]
            .rows
            .shares_storage_with(&next.datasets[0].rows)
    );
    for i in 1..8 {
        assert!(
            source.datasets[i]
                .rows
                .shares_storage_with(&next.datasets[i].rows)
        );
    }
    next.datasets[1].rows.push(vec![json!("local")]);
    assert_eq!(source.datasets[1].rows.len(), 16);
}

#[test]
fn wire_array_and_complete_chart_round_trip_keep_the_original_contract() {
    let value = json!([[null, true, 42, 1.25, "泵😀"], []]);
    let rows: ChartRows = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&rows).unwrap(), value);
    for invalid in [json!(null), json!({"rows": []}), json!([1]), json!("data")] {
        assert!(serde_json::from_value::<ChartRows>(invalid).is_err());
    }
    let original = fixture(3);
    let bytes = serde_json::to_vec(&original).unwrap();
    let decoded = parse_chart_ir(&bytes).unwrap();
    assert_eq!(decoded, original);
    assert_eq!(serde_json::to_vec(&decoded).unwrap(), bytes);
}

#[test]
fn successful_update_shares_unchanged_data_and_old_runtime_stays_readable() {
    let mut runtime = ChartRuntime::new(fixture(16), 640.0, 360.0).unwrap();
    let old = runtime.clone();
    update(
        &mut runtime,
        vec![vec![json!("新设备"), json!(9), json!(0.5), json!("泵")]],
        None,
    )
    .unwrap();
    assert_eq!(old.source().datasets[0].rows.len(), 16);
    assert_eq!(runtime.source().datasets[0].rows.len(), 1);
    assert!(
        !old.source().datasets[0]
            .rows
            .shares_storage_with(&runtime.source().datasets[0].rows)
    );
    for i in 1..8 {
        assert!(
            old.source().datasets[i]
                .rows
                .shares_storage_with(&runtime.source().datasets[i].rows)
        );
    }
    assert_eq!(old.data_revision(), 0);
    assert_eq!(runtime.data_revision(), 1);
}

#[test]
fn append_eviction_and_empty_append_preserve_snapshot_identity() {
    let mut runtime = ChartRuntime::new(fixture(3), 640.0, 360.0).unwrap();
    let original = runtime.clone();
    update(&mut runtime, vec![], Some(3)).unwrap();
    assert!(std::ptr::eq(runtime.source(), original.source()));
    update(&mut runtime, vec![], Some(2)).unwrap();
    assert_eq!(runtime.source().datasets[0].rows[0][0], "设备-1");
    assert_eq!(original.source().datasets[0].rows.len(), 3);
    let incoming = (0..5)
        .map(|i| vec![json!(format!("new-{i}")), json!(i), json!(0.5), json!("泵")])
        .collect();
    update(&mut runtime, incoming, Some(2)).unwrap();
    assert_eq!(runtime.source().datasets[0].rows[0][0], "new-3");
    assert_eq!(runtime.source().datasets[0].rows[1][0], "new-4");
    assert!(
        original.source().datasets[1]
            .rows
            .shares_storage_with(&runtime.source().datasets[1].rows)
    );
}

#[test]
fn semantically_invalid_candidate_preserves_source_storage_state_and_geometry() {
    let mut runtime = ChartRuntime::new(fixture(3), 640.0, 360.0).unwrap();
    let old = runtime.clone();
    // 合法标量和行宽，在候选完整 ChartIR 的数值列检查时失败。
    assert!(
        update(
            &mut runtime,
            vec![vec![
                json!("A"),
                json!("not-number"),
                json!(0.5),
                json!("泵")
            ]],
            None
        )
        .is_err()
    );
    assert!(std::ptr::eq(runtime.source(), old.source()));
    assert!(std::ptr::eq(runtime.frame(), old.frame()));
    assert_eq!(runtime.state(), old.state());
    assert_eq!(runtime.data_revision(), 0);
    assert!(
        update(
            &mut runtime,
            vec![vec![json!({}), json!(1), json!(0.5), json!("泵")]],
            Some(1)
        )
        .is_err()
    );
    assert!(
        runtime.source().datasets[0]
            .rows
            .shares_storage_with(&old.source().datasets[0].rows)
    );
}

#[test]
#[ignore = "explicit source-snapshot benchmark; run release with --ignored --nocapture"]
fn benchmark_source_snapshot_copy() {
    let source = fixture(8192);
    let mut deep = Vec::new();
    let mut shared = Vec::new();
    for round in 0..25 {
        for offset in 0..2 {
            let legacy = (round + offset) % 2 == 0;
            let start = Instant::now();
            let mut candidate = source.clone();
            if legacy {
                // 复现旧版逐单元复制；新的元数据 clone 额外含每数据集一次 Arc clone。
                for data in &mut candidate.datasets {
                    data.rows = data.rows.to_vec().into();
                }
            }
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(candidate, source);
            if round >= 5 {
                if legacy {
                    deep.push(elapsed);
                } else {
                    shared.push(elapsed);
                }
            }
            black_box(candidate);
        }
    }
    deep.sort_by(f64::total_cmp);
    shared.sort_by(f64::total_cmp);
    println!(
        "{}",
        json!({"datasets":8,"rowsPerDataset":8192,"warmup":5,"samples":20,
        "deepCopyMedianMs":deep[10],"deepCopyP95Ms":deep[18],"sharedMedianMs":shared[10],"sharedP95Ms":shared[18],
        "scope":"source snapshot clone only; excludes validation, row patch, geometry and GPU"})
    );
}

#[test]
#[ignore = "explicit validation benchmark; run release with --ignored --nocapture"]
fn benchmark_repeated_source_validation() {
    let source = fixture(8192);
    assert!(deep_engine_native::chart::validate_chart_ir(&source).valid);
    let mut times = Vec::new();
    for round in 0..25 {
        let start = Instant::now();
        let validation = deep_engine_native::chart::validate_chart_ir(black_box(&source));
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        assert!(validation.valid);
        if round >= 5 {
            times.push(elapsed);
        }
    }
    times.sort_by(f64::total_cmp);
    println!(
        "{}",
        json!({"datasets":8,"rowsPerDataset":8192,"warmup":5,"samples":20,
        "validationMedianMs":times[10],"validationP95Ms":times[18],"scope":"complete unchanged ChartIR validation"})
    );
}

#[test]
fn row_stats_cache_reuses_shared_scan_and_invalidates_on_any_mutable_access() {
    use std::sync::Arc;
    let mut source = fixture(16);
    assert!(deep_engine_native::chart::validate_chart_ir(&source).valid);
    let first = source.datasets[0]
        .rows
        .cached_stats()
        .expect("validation caches stats");
    // 快照克隆共享行存储,统计只有一份;独立数据集各持各的统计。
    let snapshot = source.clone();
    assert!(
        source.datasets[0]
            .rows
            .shares_storage_with(&snapshot.datasets[0].rows)
    );
    let shared = snapshot.datasets[0]
        .rows
        .cached_stats()
        .expect("shared storage reuses stats");
    assert!(Arc::ptr_eq(&first, &shared));
    // 可变访问立即失效被写数据集的统计;原快照不受影响。
    source.datasets[0]
        .rows
        .push(vec![json!("新"), json!(1), json!(0.5), json!("泵")]);
    assert!(source.datasets[0].rows.cached_stats().is_none());
    let kept = snapshot.datasets[0]
        .rows
        .cached_stats()
        .expect("untouched snapshot keeps stats");
    assert!(Arc::ptr_eq(&kept, &first));
    assert!(deep_engine_native::chart::validate_chart_ir(&source).valid);
}

#[test]
fn stats_driven_validation_preserves_direct_row_scan_semantics() {
    // 数值列混入字符串:与既有候选拒绝行为同源,统计路径同样判非法。
    let mut broken = fixture(4);
    broken.datasets[0].rows[0][1] = json!("not-a-number");
    assert!(!deep_engine_native::chart::validate_chart_ir(&broken).valid);
    let mut healthy = broken;
    healthy.datasets[0].rows[0][1] = json!(3);
    assert!(deep_engine_native::chart::validate_chart_ir(&healthy).valid);
}

#[test]
fn row_stats_answer_column_queries_for_ragged_short_and_empty_storage() {
    let rows: ChartRows = vec![vec![json!(1), json!(2)], vec![json!(1)]].into();
    let stats = rows.stats();
    assert!(stats.column_is_finite(0));
    assert!(
        !stats.column_is_finite(1),
        "短行缺列等价于原 get(column)=None 失败"
    );
    let zero: ChartRows = vec![vec![json!(0)]].into();
    assert!(zero.stats().column_is_finite(0));
    assert!(
        !zero.stats().column_is_positive(0),
        "0 不满足 log 轴正数要求"
    );
    let one: ChartRows = vec![vec![json!(1.5)]].into();
    assert!(one.stats().column_is_finite(0) && one.stats().column_is_positive(0));
    let text: ChartRows = vec![vec![json!("分类")]].into();
    assert!(!text.stats().column_is_finite(0));
    let empty: ChartRows = Vec::new().into();
    assert!(
        empty.stats().column_is_finite(0) && empty.stats().column_is_positive(0),
        "空数据集等价于 iter().any() 为假,全部通过"
    );
    let long: ChartRows = vec![vec![json!("超".repeat(5000))]].into();
    assert!(long.stats().string_over_budget);
    let short_text: ChartRows = vec![vec![json!("短")]].into();
    assert!(!short_text.stats().string_over_budget);
}
