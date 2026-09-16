use deep_engine_native::chart::{
    ChartAction, ChartGeometryFrame, ChartIR, ChartScale, InteractionState, parse_chart_ir,
};
use serde_json::json;

fn chart(series_id: &str) -> ChartIR {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.series.retain(|series| series.id == series_id);
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = false;
    ir
}
#[test]
fn point_shapes_resolve_original_data_rows_and_series() {
    let ir = chart("scatter");
    let frame =
        ChartGeometryFrame::prepare(&ir, &InteractionState::default(), 216.0, 216.0).unwrap();
    let hit = frame.hit(58.0, 188.0).unwrap();
    assert_eq!(hit.series_id, "scatter");
    assert_eq!(hit.data_index, Some(0));
    assert_eq!(frame.hit(158.0, 168.0).unwrap().data_index, Some(1));
    assert!(frame.hit(108.0, 108.0).is_none());
    for (x, y) in [(f64::NAN, 188.0), (58.0, f64::INFINITY)] {
        assert!(frame.hit(x, y).is_none());
    }
}
#[test]
fn skipped_pie_values_and_zero_bars_do_not_renumber_rows() {
    let mut ir = chart("pie");
    ir.datasets[0].rows[0][2] = json!(-1);
    let frame =
        ChartGeometryFrame::prepare(&ir, &InteractionState::default(), 216.0, 216.0).unwrap();
    assert_eq!(frame.hit(108.0, 108.0).unwrap().data_index, Some(1));
    let mut ir = chart("bar");
    ir.datasets[0].rows[0][1] = json!(0);
    let frame =
        ChartGeometryFrame::prepare(&ir, &InteractionState::default(), 216.0, 216.0).unwrap();
    assert!(frame.hit(58.0, 188.0).is_none());
    assert_eq!(frame.hit(158.0, 188.0).unwrap().data_index, Some(1));
}
#[test]
fn zoom_clip_hidden_series_and_failed_candidates_keep_snapshot_consistent() {
    let mut ir = chart("heat");
    ir.axes[1].scale = ChartScale::Category;
    ir.axes[1].min = None;
    ir.axes[1].max = None;
    let mut state = InteractionState::default();
    let original = ChartGeometryFrame::prepare(&ir, &state, 216.0, 216.0).unwrap();
    assert_eq!(original.hit(58.0, 58.0).unwrap().data_index, Some(0));
    state
        .apply(
            &ir,
            ChartAction::Zoom {
                axis_id: "x".into(),
                start: 0.0,
                end: 0.5,
            },
        )
        .unwrap();
    let zoomed = ChartGeometryFrame::prepare(&ir, &state, 216.0, 216.0).unwrap();
    assert_eq!(zoomed.hit(158.0, 58.0).unwrap().data_index, Some(0));
    assert!(zoomed.hit(250.0, 158.0).is_none());
    assert!(original.hit(158.0, 58.0).is_none());
    state
        .apply(
            &ir,
            ChartAction::ToggleLegend {
                series_id: "heat".into(),
            },
        )
        .unwrap();
    let hidden = ChartGeometryFrame::prepare(&ir, &state, 216.0, 216.0).unwrap();
    assert!(hidden.hit(158.0, 58.0).is_none());
    assert!(hidden.display_list().commands.is_empty());
    state.zoom_windows.push(("missing".into(), 0.0, 1.0));
    assert!(ChartGeometryFrame::prepare(&ir, &state, 216.0, 216.0).is_err());
    assert_eq!(zoomed.hit(158.0, 58.0).unwrap().data_index, Some(0));
}
#[test]
fn overlapping_series_follow_draw_order_and_line_hits_are_series_level() {
    let mut ir = chart("scatter");
    let mut top = ir.series[0].clone();
    top.id = "top".into();
    ir.series.push(top);
    let frame =
        ChartGeometryFrame::prepare(&ir, &InteractionState::default(), 216.0, 216.0).unwrap();
    assert_eq!(frame.hit(58.0, 188.0).unwrap().series_id, "top");
    let ir = chart("line");
    let frame =
        ChartGeometryFrame::prepare(&ir, &InteractionState::default(), 216.0, 216.0).unwrap();
    let hit = frame.hit(108.0, 178.0).unwrap();
    assert_eq!(hit.series_id, "line");
    assert_eq!(hit.data_index, None);
}
