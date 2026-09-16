use deep_engine_native::chart::{
    ChartAction, ChartDataUpdate, ChartGeometryFrame, ChartRuntime, ChartScale, DatasetRowsUpdate,
    parse_chart_ir, render_chart_with_windows,
};
use deep_engine_native::deep2d::{Deep2dDisplayList, Deep2dResource};
use serde_json::json;

fn runtime() -> ChartRuntime {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = false;
    ir.series
        .retain(|s| s.id == "line" || s.id == "bar" || s.id == "scatter");
    let source = ir.datasets[0].clone();
    ir.datasets.clear();
    for series in &mut ir.series {
        let mut dataset = source.clone();
        dataset.id = series.id.clone();
        series.dataset_id = dataset.id.clone();
        ir.datasets.push(dataset);
    }
    let mut second_x = ir.axes[0].clone();
    second_x.id = "second-x".into();
    ir.series
        .iter_mut()
        .find(|s| s.id == "scatter")
        .unwrap()
        .x_axis_id = Some(second_x.id.clone());
    ir.axes.push(second_x);
    ChartRuntime::new(ir, 216.0, 216.0).unwrap()
}
fn normalized(mut list: Deep2dDisplayList) -> Deep2dDisplayList {
    list.revision = 0;
    for resource in &mut list.resources {
        if let Deep2dResource::Path(path) = resource {
            path.revision = 0;
        }
    }
    list
}
fn equivalent(chart: &ChartRuntime, width: f64, height: f64) {
    let reference = render_chart_with_windows(
        chart.source(),
        width,
        height,
        &chart.state().hidden_series,
        &chart.state().zoom_windows,
    )
    .unwrap();
    assert_eq!(normalized(chart.frame().display_list().clone()), reference);
    let fresh = ChartGeometryFrame::prepare(chart.source(), chart.state(), width, height).unwrap();
    for y in (0..height as usize).step_by(7) {
        for x in (0..width as usize).step_by(7) {
            assert_eq!(
                chart.frame().hit(x as f64, y as f64),
                fresh.hit(x as f64, y as f64)
            );
            assert_eq!(
                chart.frame().pick(x as f64, y as f64),
                fresh.pick(x as f64, y as f64)
            );
        }
    }
    for index in 0..reference.commands.len() + 1 {
        assert_eq!(
            chart.frame().command_target(index),
            fresh.command_target(index)
        );
    }
}
fn replace_rows(chart: &mut ChartRuntime, dataset: &str, y: f64) {
    let revision = chart.data_revision();
    chart
        .update_data(ChartDataUpdate {
            expected_data_revision: revision,
            data_revision: revision + 1,
            datasets: vec![DatasetRowsUpdate::Replace {
                dataset_id: dataset.into(),
                rows: vec![vec![json!("A"), json!(y), json!(0.3), json!("泵")]],
            }],
        })
        .unwrap();
}
fn resource_revisions(chart: &ChartRuntime, series: &str) -> Vec<u64> {
    chart
        .frame()
        .display_list()
        .resources
        .iter()
        .enumerate()
        .filter_map(|(i, r)| {
            if chart.frame().command_target(i)?.series_id != series {
                return None;
            }
            Some(match r {
                Deep2dResource::Path(p) => p.revision,
                _ => unreachable!(),
            })
        })
        .collect()
}

#[test]
fn one_dataset_rebuilds_only_its_series_and_keeps_other_path_versions() {
    let mut chart = runtime();
    let old = chart.clone();
    replace_rows(&mut chart, "bar", 6.0);
    let work = chart.frame().work();
    assert_eq!(
        (
            work.series_rebuilt,
            work.series_reused,
            work.hit_indexes_rebuilt,
            work.line_indexes_rebuilt
        ),
        (1, 2, 1, 0)
    );
    assert_eq!(
        resource_revisions(&chart, "line"),
        resource_revisions(&old, "line")
    );
    assert_eq!(
        resource_revisions(&chart, "scatter"),
        resource_revisions(&old, "scatter")
    );
    assert!(
        resource_revisions(&chart, "bar")
            .iter()
            .all(|revision| *revision == chart.revision())
    );
    equivalent(&chart, 216.0, 216.0);
    equivalent(&old, 216.0, 216.0);
}

#[test]
fn zoom_invalidates_only_series_using_the_axis_and_resize_invalidates_all() {
    let mut chart = runtime();
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "second-x".into(),
            start: 0.25,
            end: 0.75,
        })
        .unwrap();
    assert_eq!(
        (
            chart.frame().work().series_rebuilt,
            chart.frame().work().series_reused
        ),
        (1, 2)
    );
    equivalent(&chart, 216.0, 216.0);
    chart.resize(320.0, 240.0).unwrap();
    assert_eq!(chart.frame().work().series_rebuilt, 3);
    equivalent(&chart, 320.0, 240.0);
}

#[test]
fn hidden_updates_cannot_resurrect_a_stale_cached_series() {
    let mut chart = runtime();
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "line".into(),
        })
        .unwrap();
    assert_eq!(
        (
            chart.frame().work().series_rebuilt,
            chart.frame().work().series_reused
        ),
        (0, 2)
    );
    let hidden = chart.clone();
    replace_rows(&mut chart, "line", 9.0);
    assert!(std::ptr::eq(chart.frame(), hidden.frame()));
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "line".into(),
        })
        .unwrap();
    assert_eq!(
        (
            chart.frame().work().series_rebuilt,
            chart.frame().work().series_reused
        ),
        (1, 2)
    );
    assert_eq!(chart.frame().work().line_indexes_rebuilt, 1);
    equivalent(&chart, 216.0, 216.0);
}

#[test]
fn full_replacement_resets_dependencies_and_failed_resize_keeps_shared_snapshot() {
    let mut chart = runtime();
    let old = chart.clone();
    assert!(chart.resize(1.0, 1.0).is_err());
    assert!(std::ptr::eq(chart.frame(), old.frame()));
    let mut ir = chart.source().clone();
    ir.axes[0].scale = ChartScale::Linear;
    for dataset in &mut ir.datasets {
        dataset.rows[0][0] = json!(1);
        dataset.rows[1][0] = json!(4);
    }
    ir.series.reverse();
    chart.replace(ir).unwrap();
    assert_eq!(chart.frame().work().series_rebuilt, 3);
    equivalent(&chart, 216.0, 216.0);
}

#[test]
fn all_six_series_match_the_existing_whole_frame_renderer() {
    let ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    let chart = ChartRuntime::new(ir, 640.0, 360.0).unwrap();
    equivalent(&chart, 640.0, 360.0);
}
