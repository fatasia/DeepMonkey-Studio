use deep_engine_native::chart::interaction_contract::TooltipTrigger;
use deep_engine_native::chart::{ChartAction, ChartIR, ChartRuntime, parse_chart_ir};
use deep_engine_native::deep2d::Deep2dResource;

fn chart(id: &str) -> ChartIR {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.series.retain(|series| series.id == id);
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = false;
    ir.tooltip.trigger = TooltipTrigger::Item;
    ir
}
fn frame(runtime: &ChartRuntime) -> serde_json::Value {
    serde_json::to_value(runtime.frame().display_list()).unwrap()
}

#[test]
fn candidate_shares_immutable_data_and_preserves_active_state_until_commit() {
    let active = ChartRuntime::new(chart("scatter"), 216.0, 216.0).unwrap();
    let mut candidate = active.clone();
    assert!(std::ptr::eq(active.source(), candidate.source()));
    assert!(std::ptr::eq(active.frame(), candidate.frame()));
    candidate.pointer_move(58.0, 188.0).unwrap();
    assert!(active.state().tooltip.is_none());
    assert!(candidate.state().tooltip.is_some());
    assert!(std::ptr::eq(active.frame(), candidate.frame()));
    candidate
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.0,
            end: 0.5,
        })
        .unwrap();
    assert!(!std::ptr::eq(active.frame(), candidate.frame()));
    assert!(active.state().zoom_windows.is_empty());
}

#[test]
fn pointer_hover_uses_committed_values_and_selection_does_not_rebuild_geometry() {
    let mut runtime = ChartRuntime::new(chart("scatter"), 216.0, 216.0).unwrap();
    let original = frame(&runtime);
    assert!(runtime.pointer_move(58.0, 188.0).unwrap());
    let tooltip = runtime.state().tooltip.as_ref().unwrap();
    assert_eq!(
        (&tooltip.x_value, &tooltip.y_value),
        (&"A".to_owned(), &"1".to_owned())
    );
    assert!(!runtime.pointer_move(58.0, 188.0).unwrap());
    assert!(runtime.pointer_select(58.0, 188.0).unwrap());
    assert_eq!(runtime.state().selected, vec![("scatter".into(), Some(0))]);
    assert_eq!(frame(&runtime), original);
    assert!(runtime.pointer_select(58.0, 188.0).unwrap());
    assert!(runtime.state().selected.is_empty());
    assert!(runtime.pointer_move(0.0, 0.0).unwrap());
    assert!(runtime.state().tooltip.is_none());
    assert!(!runtime.pointer_select(0.0, 0.0).unwrap());
}

#[test]
fn geometry_commits_update_revision_and_discard_stale_hover() {
    let mut runtime = ChartRuntime::new(chart("scatter"), 216.0, 216.0).unwrap();
    runtime.pointer_move(58.0, 188.0).unwrap();
    let original_revision = runtime.revision();
    runtime
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.0,
            end: 0.5,
        })
        .unwrap();
    assert!(runtime.revision() > original_revision);
    assert!(runtime.state().tooltip.is_none());
    assert_eq!(runtime.frame().display_list().revision, runtime.revision());
    for resource in &runtime.frame().display_list().resources {
        let Deep2dResource::Path(path) = resource else {
            panic!("path")
        };
        assert_eq!(path.revision, runtime.revision());
    }
    assert!(runtime.frame().hit(108.0, 188.0).is_some());
    runtime
        .dispatch(ChartAction::ToggleLegend {
            series_id: "scatter".into(),
        })
        .unwrap();
    assert!(runtime.frame().hit(108.0, 188.0).is_none());
}

#[test]
fn failed_geometry_resize_and_source_replacement_keep_every_committed_field() {
    let mut runtime = ChartRuntime::new(chart("scatter"), 216.0, 216.0).unwrap();
    runtime.pointer_move(58.0, 188.0).unwrap();
    let original = frame(&runtime);
    let state = runtime.state().clone();
    let revision = runtime.revision();
    assert!(
        runtime
            .dispatch(ChartAction::Zoom {
                axis_id: "x".into(),
                start: 0.0,
                end: 1e-20
            })
            .is_err()
    );
    assert!(runtime.resize(8.0, 8.0).is_err());
    let mut invalid = chart("scatter");
    invalid.series[0].dataset_id = "missing".into();
    assert!(runtime.replace(invalid).is_err());
    assert_eq!(frame(&runtime), original);
    assert_eq!(runtime.state(), &state);
    assert_eq!(runtime.revision(), revision);
    assert_eq!(runtime.source().series[0].dataset_id, "main");
    assert!(runtime.frame().hit(58.0, 188.0).is_some());
}

#[test]
fn replacement_resets_authored_state_and_line_hover_remains_series_level() {
    let mut runtime = ChartRuntime::new(chart("scatter"), 216.0, 216.0).unwrap();
    runtime.pointer_select(58.0, 188.0).unwrap();
    runtime.replace(chart("line")).unwrap();
    assert!(runtime.state().selected.is_empty());
    runtime.pointer_move(108.0, 178.0).unwrap();
    assert_eq!(runtime.state().highlighted, Some(("line".into(), None)));
    assert!(runtime.state().tooltip.is_none());
    let revision = runtime.revision();
    assert!(!runtime.resize(216.0, 216.0).unwrap());
    assert_eq!(runtime.revision(), revision);
    assert!(runtime.resize(416.0, 216.0).unwrap());
    assert!(runtime.state().highlighted.is_none());
    assert!(runtime.frame().hit(208.0, 178.0).is_some());
}
