use deep_engine_native::chart::{
    ChartAction, ChartRuntime, interaction_contract::ChartInitialAction, parse_chart_ir,
    state_render::append_state_outlines,
};
use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dRuntimeContent, prepare_runtime_content,
};
use deep_engine_native::native_ui::design_tokens::DesignTokenSnapshot;

fn chart() -> ChartRuntime {
    let mut source = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    source.actions.clear();
    source.data_zoom.clear();
    source.legend.visible = false;
    ChartRuntime::new(source, 640.0, 360.0).unwrap()
}
fn render(chart: &ChartRuntime) -> Deep2dDisplayList {
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    let mut list = chart.frame().display_list().clone();
    append_state_outlines(&mut list, chart, &tokens.themes.dark).unwrap();
    prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(list.clone())).unwrap();
    list
}

#[test]
fn all_series_outlines_reuse_paths_without_mutating_geometry_or_adding_hits() {
    for id in ["line", "bar", "scatter", "pie", "heat", "gauge"] {
        let mut chart = chart();
        if !chart.source().series.iter().any(|series| series.id == id) {
            panic!("missing fixture series {id}");
        }
        let original = serde_json::to_value(chart.frame().display_list()).unwrap();
        chart
            .dispatch(ChartAction::Select {
                series_id: id.into(),
                data_index: None,
            })
            .unwrap();
        let list = render(&chart);
        let base = chart.frame().display_list();
        let targets = base
            .commands
            .iter()
            .enumerate()
            .filter(|(i, _)| chart.frame().command_target(*i).unwrap().series_id == id)
            .collect::<Vec<_>>();
        assert!(!targets.is_empty());
        assert_eq!(list.commands.len(), base.commands.len() + targets.len());
        for ((_, command), overlay) in targets.iter().zip(&list.commands[base.commands.len()..]) {
            let (Deep2dCommand::Path(path), Deep2dCommand::Path(outline)) = (command, overlay)
            else {
                panic!()
            };
            assert_eq!(outline.path_id, path.path_id);
            assert_eq!(outline.clip_rect, path.clip_rect);
            assert_eq!(outline.transform, path.transform);
            assert!(outline.hit_id.is_none());
            assert!(outline.fill.is_none());
            assert_eq!(outline.stroke_width, Some(3.0));
            assert!(outline.dash.is_none());
        }
        assert_eq!(list.resources.len(), base.resources.len());
        assert_eq!(serde_json::to_value(base).unwrap(), original);
        let count = base.commands.len();
        chart
            .dispatch(ChartAction::Deselect {
                series_id: id.into(),
                data_index: None,
            })
            .unwrap();
        assert_eq!(render(&chart).commands.len(), count);
    }
}

#[test]
fn individual_hover_selection_priority_and_hidden_series_are_precise() {
    let mut chart = chart();
    chart
        .dispatch(ChartAction::Hover {
            series_id: "scatter".into(),
            data_index: 0,
            x_label: "A".into(),
            value: "1".into(),
        })
        .unwrap();
    let base = chart.frame().display_list().commands.len();
    let hovered = render(&chart);
    assert_eq!(hovered.commands.len(), base + 1);
    let Deep2dCommand::Path(path) = hovered.commands.last().unwrap() else {
        panic!()
    };
    assert_eq!(path.stroke_width, Some(2.0));
    chart
        .dispatch(ChartAction::Select {
            series_id: "scatter".into(),
            data_index: Some(0),
        })
        .unwrap();
    let selected = render(&chart);
    assert_eq!(selected.commands.len(), base + 1);
    let Deep2dCommand::Path(path) = selected.commands.last().unwrap() else {
        panic!()
    };
    assert_eq!(path.stroke_width, Some(3.0));
    chart.dispatch(ChartAction::HoverEnd).unwrap();
    assert_eq!(render(&chart).commands.len(), base + 1);
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "scatter".into(),
        })
        .unwrap();
    assert_eq!(
        render(&chart).commands.len(),
        chart.frame().display_list().commands.len()
    );
}

#[test]
fn persistent_emphasis_exceptions_and_bad_theme_do_not_corrupt_list() {
    let mut chart = chart();
    let mut source = chart.source().clone();
    source.actions = vec![
        ChartInitialAction::Highlight {
            series_id: "scatter".into(),
            data_index: None,
        },
        ChartInitialAction::Downplay {
            series_id: "scatter".into(),
            data_index: Some(0),
        },
        ChartInitialAction::Highlight {
            series_id: "line".into(),
            data_index: Some(0),
        },
    ];
    chart.replace(source).unwrap();
    let list = render(&chart);
    let base = chart.frame().display_list().commands.len();
    assert!(list.commands.len() > base);
    for command in &list.commands[base..] {
        let Deep2dCommand::Path(path) = command else {
            panic!()
        };
        if path.id.starts_with("point-") {
            // P1-15: authored 的 row 级 Highlight 额外产生持久 marker（无 dash）。
            assert!(path.dash.is_none());
        } else {
            assert_eq!(path.dash, Some(vec![4.0, 3.0]));
        }
    }
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    let mut theme = tokens.themes.dark;
    theme.colors.accent = Some([f64::NAN; 4]);
    let mut rejected = chart.frame().display_list().clone();
    let before = serde_json::to_value(&rejected).unwrap();
    assert!(append_state_outlines(&mut rejected, &chart, &theme).is_err());
    assert_eq!(serde_json::to_value(&rejected).unwrap(), before);
}

#[test]
fn selected_line_datum_draws_only_its_marker_and_follows_zoom() {
    let mut chart = chart();
    let original = serde_json::to_value(chart.frame().display_list()).unwrap();
    chart
        .dispatch(ChartAction::Select {
            series_id: "line".into(),
            data_index: Some(0),
        })
        .unwrap();
    let selected = render(&chart);
    let base = chart.frame().display_list();
    assert_eq!(selected.commands.len(), base.commands.len() + 1);
    assert_eq!(selected.resources.len(), base.resources.len() + 1);
    let Deep2dCommand::Path(marker) = selected.commands.last().unwrap() else {
        panic!()
    };
    assert!(marker.id.starts_with("point-"));
    assert!(marker.hit_id.is_none());
    assert!(marker.clip_rect.is_some());
    let id = marker.id.clone();
    let before = chart.frame().line_point_position("line", 0).unwrap();
    assert_eq!(serde_json::to_value(base).unwrap(), original);
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.0,
            end: 0.5,
        })
        .unwrap();
    let after = chart.frame().line_point_position("line", 0).unwrap();
    assert!(after[0] > before[0]);
    let zoomed = render(&chart);
    let Deep2dCommand::Path(marker) = zoomed.commands.last().unwrap() else {
        panic!()
    };
    assert_eq!(marker.id, id);
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "line".into(),
        })
        .unwrap();
    let hidden = render(&chart);
    assert_eq!(
        hidden.commands.len(),
        chart.frame().display_list().commands.len()
    );
    assert!(chart.frame().line_point_position("line", 0).is_none());
}
