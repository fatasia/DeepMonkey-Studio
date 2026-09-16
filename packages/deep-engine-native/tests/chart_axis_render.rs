use deep_engine_native::chart::{ChartIR, ChartScale, parse_chart_ir, render_chart};
use deep_engine_native::deep2d::{Deep2dPathVerb, Deep2dResource};
use serde_json::json;

fn chart() -> ChartIR {
    parse_chart_ir(
        &serde_json::to_vec(&json!({
            "schemaVersion":1,"sourceSpecVersion":1,"id":"axis-test",
            "datasets":[{"id":"d","dimensions":["x","y"],"rows":[[1,1],[10,10],[100,100]]}],
            "axes":[
                {"id":"x","channel":"x","scale":"linear","min":null,"max":null},
                {"id":"y","channel":"y","scale":"linear","min":null,"max":null}
            ],
            "series":[{"id":"line","label":"line","type":"line","datasetId":"d",
                "x":"x","y":"y","xAxisId":"x","yAxisId":"y"}],
            "legend":{"visible":false,"position":"top"},
            "tooltip":{"enabled":false,"trigger":"none"},"dataZoom":[],"actions":[]
        }))
        .unwrap(),
    )
    .unwrap()
}

fn points(ir: &ChartIR) -> Vec<(f64, f64)> {
    let list = render_chart(ir, 216.0, 216.0).unwrap();
    list_points(&list)
}
fn list_points(list: &deep_engine_native::deep2d::Deep2dDisplayList) -> Vec<(f64, f64)> {
    list.resources
        .iter()
        .flat_map(|resource| {
            let Deep2dResource::Path(path) = resource else {
                panic!("path")
            };
            path.verbs.iter().filter_map(|verb| match verb {
                Deep2dPathVerb::Move { x, y } | Deep2dPathVerb::Line { x, y } => Some((*x, *y)),
                _ => None,
            })
        })
        .collect()
}

#[test]
fn numeric_zoom_changes_geometry_and_reset_restores_original() {
    use deep_engine_native::chart::{ChartAction, InteractionState, render_chart_with_windows};
    let mut ir = chart();
    ir.axes[0].min = Some(0.0);
    ir.axes[0].max = Some(100.0);
    ir.datasets[0].rows = vec![vec![json!(20), json!(20)], vec![json!(80), json!(80)]].into();
    let original = render_chart(&ir, 216.0, 216.0).unwrap();
    let mut state = InteractionState::from_ir(&ir).unwrap();
    state
        .apply(
            &ir,
            ChartAction::Zoom {
                axis_id: "x".into(),
                start: 0.25,
                end: 0.75,
            },
        )
        .unwrap();
    let zoomed =
        render_chart_with_windows(&ir, 216.0, 216.0, &state.hidden_series, &state.zoom_windows)
            .unwrap();
    for (actual, expected) in list_points(&zoomed)
        .iter()
        .zip([(-12.0, 208.0), (228.0, 8.0)])
    {
        assert!((actual.0 - expected.0).abs() < 1e-9 && (actual.1 - expected.1).abs() < 1e-9);
    }
    for command in &zoomed.commands {
        let deep_engine_native::deep2d::Deep2dCommand::Path(path) = command else {
            panic!("path")
        };
        let rect = path.clip_rect.unwrap();
        assert_eq!(
            (rect.x, rect.y, rect.width, rect.height),
            (8.0, 8.0, 200.0, 200.0)
        );
    }
    state.apply(&ir, ChartAction::ResetZoom).unwrap();
    let restored =
        render_chart_with_windows(&ir, 216.0, 216.0, &state.hidden_series, &state.zoom_windows)
            .unwrap();
    assert_eq!(
        serde_json::to_value(original).unwrap(),
        serde_json::to_value(restored).unwrap()
    );
}

#[test]
fn logarithmic_and_category_windows_use_their_own_scale_space() {
    use deep_engine_native::chart::render_chart_with_windows;
    let mut ir = chart();
    ir.axes[0].scale = ChartScale::Log;
    let list =
        render_chart_with_windows(&ir, 216.0, 216.0, &[], &[("x".into(), 0.0, 0.5)]).unwrap();
    assert_eq!(
        list_points(&list).iter().map(|p| p.0).collect::<Vec<_>>(),
        vec![8.0, 208.0, 408.0]
    );
    ir.axes[0].scale = ChartScale::Category;
    let list =
        render_chart_with_windows(&ir, 216.0, 216.0, &[], &[("x".into(), 0.0, 0.5)]).unwrap();
    let xs = list_points(&list).iter().map(|p| p.0).collect::<Vec<_>>();
    assert!((xs[0] - (8.0 + 200.0 / 3.0)).abs() < 1e-9);
    assert_eq!(xs[1], 208.0);
}

#[test]
fn invalid_runtime_windows_are_rejected_without_modifying_source() {
    use deep_engine_native::chart::render_chart_with_windows;
    let ir = chart();
    let before = serde_json::to_value(&ir).unwrap();
    for windows in [
        vec![("missing".into(), 0.0, 1.0)],
        vec![("x".into(), 0.5, 0.5)],
        vec![("x".into(), f64::NAN, 1.0)],
        vec![("x".into(), -0.1, 1.0)],
        vec![("x".into(), 0.0, 1.1)],
        vec![("x".into(), 0.0, 1.0), ("x".into(), 0.0, 0.5)],
    ] {
        assert!(render_chart_with_windows(&ir, 216.0, 216.0, &[], &windows).is_err());
        assert_eq!(serde_json::to_value(&ir).unwrap(), before);
    }
}

#[test]
fn logarithmic_axes_place_decades_at_equal_pixel_intervals() {
    let mut ir = chart();
    for axis in &mut ir.axes {
        axis.scale = ChartScale::Log;
    }
    assert_eq!(
        points(&ir),
        vec![(8.0, 208.0), (108.0, 108.0), (208.0, 8.0)]
    );
}

#[test]
fn independently_authored_min_and_max_change_actual_geometry() {
    let mut ir = chart();
    ir.datasets[0].rows = vec![vec![json!(20), json!(20)], vec![json!(80), json!(80)]].into();
    ir.axes[0].min = Some(0.0);
    ir.axes[1].max = Some(100.0);
    assert_eq!(points(&ir), vec![(58.0, 208.0), (208.0, 58.0)]);
    ir.axes[0].max = Some(100.0);
    ir.axes[1].min = Some(0.0);
    assert_eq!(points(&ir), vec![(48.0, 168.0), (168.0, 48.0)]);
}

#[test]
fn invalid_programmatic_log_domain_does_not_fall_back_to_linear() {
    let mut ir = chart();
    ir.axes[0].scale = ChartScale::Log;
    ir.axes[0].min = Some(0.0);
    ir.axes[0].max = Some(100.0);
    assert!(points(&ir).is_empty());
}

#[test]
fn initial_y_window_is_applied_in_log_space() {
    use deep_engine_native::chart::interaction_contract::{ChartDataZoom, ZoomMode};
    use deep_engine_native::chart::{InteractionState, render_chart_with_windows};
    let mut ir = chart();
    ir.axes[1].scale = ChartScale::Log;
    ir.data_zoom.push(ChartDataZoom {
        id: "zoom".into(),
        axis_id: "y".into(),
        start: 0.0,
        end: 50.0,
        mode: ZoomMode::Inside,
    });
    let state = InteractionState::from_ir(&ir).unwrap();
    let list =
        render_chart_with_windows(&ir, 216.0, 216.0, &state.hidden_series, &state.zoom_windows)
            .unwrap();
    assert_eq!(
        list_points(&list).iter().map(|p| p.1).collect::<Vec<_>>(),
        vec![208.0, 8.0, -192.0]
    );
}

#[test]
fn shared_heatmap_fixture_accepts_axis_windows() {
    use deep_engine_native::chart::render_chart_with_windows;
    let ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    let series = ir.series.iter().find(|series| series.id == "heat").unwrap();
    let axis = series.x_axis_id.as_ref().unwrap();
    let list =
        render_chart_with_windows(&ir, 480.0, 320.0, &[], &[(axis.clone(), 0.0, 0.5)]).unwrap();
    assert!(!list.commands.is_empty());
}
