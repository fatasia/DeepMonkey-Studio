use super::{axis_cache::FrameAxisValues, cartesian::*, *};

fn fixture() -> ChartIR {
    let mut ir = crate::chart::parse_chart_ir(include_bytes!(
        "../../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    let series = ir
        .series
        .iter()
        .find(|s| s.series_type == ChartSeriesType::Line)
        .unwrap()
        .clone();
    let data = dataset(&ir, &series.dataset_id).unwrap().clone();
    ir.series.clear();
    ir.datasets.clear();
    for index in 0..4 {
        let mut next = series.clone();
        next.id = format!("line-{index}");
        next.dataset_id = format!("dataset-{index}");
        let mut rows = data.clone();
        rows.id = next.dataset_id.clone();
        let y = dim(&rows, &next.y).unwrap();
        for row in rows.rows.iter_mut() {
            row[y] = serde_json::json!(index as f64 + 1.5);
        }
        ir.series.push(next);
        ir.datasets.push(rows);
    }
    ir
}

fn compare(ir: &ChartIR, windows: &[(String, f64, f64)]) {
    let mut shared = FrameAxisValues::new(ir);
    for series in &ir.series {
        for horizontal in [false, true] {
            assert_eq!(
                shared.get(series, horizontal).as_ref(),
                shared_axis_values(ir, series, horizontal)
            );
        }
        let data = dataset(ir, &series.dataset_id).unwrap();
        let reference = map_cartesian(ir, series, data, [8.0, 8.0, 1264.0, 704.0], windows);
        let cached = map_cartesian_cached(
            &mut shared,
            series,
            data,
            [8.0, 8.0, 1264.0, 704.0],
            windows,
        );
        match (reference, cached) {
            (None, None) => {}
            (Some(expected), Some(actual)) => {
                assert_eq!(actual.points, expected.points);
                assert_eq!(actual.data_indices, expected.data_indices);
                assert_eq!(actual.band, expected.band);
                assert_eq!(actual.baseline, expected.baseline);
                for x in [-1.0, 8.0, 320.0, 1272.0, 2000.0, f64::NAN] {
                    assert_eq!(actual.invert_x.invert(x), expected.invert_x.invert(x));
                }
            }
            _ => panic!("cached and uncached mapping disagree on rejection"),
        }
    }
}

#[test]
fn shared_domains_preserve_series_order_and_separate_axes() {
    let mut ir = fixture();
    let mut second_axis = axis_of(&ir, ir.series[0].y_axis_id.as_ref())
        .unwrap()
        .clone();
    second_axis.id = "second-y".into();
    ir.axes.push(second_axis);
    ir.series[1].y_axis_id = Some("second-y".into());
    compare(&ir, &[]);
    ir.series.reverse();
    compare(&ir, &[]);
    let mut cache = FrameAxisValues::new(&ir);
    let first = cache.get(&ir.series[0], false);
    let same = cache.get(&ir.series[1], false);
    let other = cache.get(&ir.series[2], false);
    assert!(std::sync::Arc::ptr_eq(&first, &same));
    assert!(!std::sync::Arc::ptr_eq(&first, &other));
}

#[test]
fn category_numeric_empty_and_bad_rows_preserve_mapping_and_rejection() {
    let mut ir = fixture();
    compare(&ir, &[]);
    for data in &mut ir.datasets {
        let x = dim(data, &ir.series[0].x).unwrap();
        for (index, row) in data.rows.iter_mut().enumerate() {
            row[x] = serde_json::json!(index as f64);
        }
    }
    let axis_id = ir.series[0].x_axis_id.clone().unwrap();
    ir.axes.iter_mut().find(|a| a.id == axis_id).unwrap().scale = ChartScale::Linear;
    compare(&ir, &[(axis_id, 0.2, 0.8)]);
    ir.datasets[0].rows.clear();
    if let Some(row) = ir.datasets[1].rows.first_mut() {
        row.clear();
    }
    compare(&ir, &[]);
    let axis = ir
        .axes
        .iter_mut()
        .find(|a| Some(&a.id) == ir.series[0].y_axis_id.as_ref())
        .unwrap();
    axis.min = Some(f64::NAN);
    compare(&ir, &[]);
}

#[test]
fn a_new_source_generation_cannot_reuse_old_axis_values() {
    let ir = fixture();
    let old = FrameAxisValues::new(&ir).get(&ir.series[0], false);
    let retained = old.to_vec();
    let mut next = ir.clone();
    let y = dim(&next.datasets[0], &next.series[0].y).unwrap();
    next.datasets[0].rows[0][y] = serde_json::json!(10_000.0);
    let current = FrameAxisValues::new(&next).get(&next.series[0], false);
    assert_ne!(current.as_ref(), old.as_ref());
    assert_eq!(old.as_ref(), retained.as_slice());
}

#[test]
fn exhausted_retention_budget_preserves_values_without_caching() {
    let ir = fixture();
    let mut cache = FrameAxisValues::with_budget(&ir, 0);
    let first = cache.get(&ir.series[0], false);
    let second = cache.get(&ir.series[0], false);
    assert_eq!(first, second);
    assert!(!std::sync::Arc::ptr_eq(&first, &second));
}
