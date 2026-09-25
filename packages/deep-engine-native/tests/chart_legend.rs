use deep_engine_native::chart::{
    ChartAction, ChartRuntime,
    interaction_contract::LegendPosition,
    legend::{LegendAction, LegendFrame},
    legend_render::append_legend,
    parse_chart_ir,
};
use deep_engine_native::{
    deep2d::{Deep2dRuntimeContent, prepare_runtime_content},
    native_ui::design_tokens::DesignTokenSnapshot,
    platform_text::TextRasterizer,
};

fn chart(position: LegendPosition, count: usize) -> ChartRuntime {
    let mut source = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    source.actions.clear();
    source.data_zoom.clear();
    source.legend.visible = true;
    source.legend.position = position;
    let series = source.series[0].clone();
    source.series = (0..count)
        .map(|index| {
            let mut s = series.clone();
            s.id = format!("series-{index}");
            s.label = format!("Pump {index}");
            s
        })
        .collect();
    ChartRuntime::new(source, 640.0, 360.0).unwrap()
}

#[test]
fn all_series_are_reachable_through_nonoverlapping_pages_in_every_position() {
    for position in [
        LegendPosition::Top,
        LegendPosition::Bottom,
        LegendPosition::Left,
        LegendPosition::Right,
    ] {
        let chart = chart(position, 128);
        let pages = LegendFrame::prepare(&chart, 0).unwrap().pages;
        let mut seen = std::collections::BTreeSet::new();
        for page in 0..pages {
            let frame = LegendFrame::prepare(&chart, page).unwrap();
            for item in &frame.items {
                let [x, y, w, h] = item.rect;
                assert!(x >= 0.0 && y >= 0.0 && x + w <= 640.0 && y + h <= 360.0);
                assert_eq!(frame.hit([x + w / 2.0, y + h / 2.0]), Some(&item.action));
                if let LegendAction::Toggle(id) = &item.action {
                    assert!(seen.insert(id.clone()));
                }
            }
            assert_eq!(
                frame
                    .items
                    .iter()
                    .filter(|item| matches!(item.action, LegendAction::Page(_)))
                    .count(),
                usize::from(page > 0) + usize::from(page + 1 < pages)
            );
            assert!(frame.hit([f64::NAN, 0.0]).is_none());
        }
        assert_eq!(seen.len(), 128);
        assert_eq!(
            LegendFrame::prepare(&chart, usize::MAX).unwrap().page,
            pages - 1
        );
    }
}

#[test]
fn hide_and_restore_keep_the_same_click_target_and_change_geometry() {
    let mut chart = chart(LegendPosition::Top, 6);
    let first = LegendFrame::prepare(&chart, 0).unwrap();
    let item = first
        .items
        .iter()
        .find(|item| matches!(item.action, LegendAction::Toggle(_)))
        .unwrap();
    let LegendAction::Toggle(id) = &item.action else {
        panic!()
    };
    let count = chart.frame().display_list().commands.len();
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: id.clone(),
        })
        .unwrap();
    assert!(chart.frame().display_list().commands.len() < count);
    let hidden = LegendFrame::prepare(&chart, 0).unwrap();
    let item2 = hidden
        .items
        .iter()
        .find(|entry| entry.action == item.action)
        .unwrap();
    assert!(item2.hidden);
    assert_eq!(item2.rect, item.rect);
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: id.clone(),
        })
        .unwrap();
    assert_eq!(chart.frame().display_list().commands.len(), count);
}

#[cfg(windows)]
#[test]
fn real_labels_prepare_in_both_themes_and_errors_leave_the_input_list_untouched() {
    let chart = chart(LegendPosition::Right, 20);
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    let mut rasterizer = TextRasterizer::new();
    for theme in [&tokens.themes.dark, &tokens.themes.light] {
        let mut list = chart.frame().display_list().clone();
        let frame = append_legend(&mut list, &chart, &mut rasterizer, theme, 0, None).unwrap();
        assert_eq!(list.atlases.len(), frame.items.len());
        prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(list)).unwrap();
    }
    let mut list = chart.frame().display_list().clone();
    let original = serde_json::to_value(&list).unwrap();
    let mut bad = tokens.themes.dark.clone();
    bad.colors.text_strong = None;
    assert!(append_legend(&mut list, &chart, &mut rasterizer, &bad, 0, None).is_err());
    assert_eq!(serde_json::to_value(&list).unwrap(), original);
}

#[test]
fn disabled_legend_has_no_hits_and_narrow_band_rejects_unusable_controls() {
    let mut chart = chart(LegendPosition::Top, 6);
    chart.resize(70.0, 216.0).unwrap();
    assert!(LegendFrame::prepare(&chart, 0).is_err());
    let mut source = chart.source().clone();
    source.legend.visible = false;
    chart.replace(source).unwrap();
    let frame = LegendFrame::prepare(&chart, 0).unwrap();
    assert!(frame.items.is_empty());
    assert_eq!(frame.pages, 0);
    assert!(frame.hit([8.0, 8.0]).is_none());
}

#[test]
fn keyboard_focus_draws_an_outward_accent_ring_into_legend_pixels() {
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    let theme = &tokens.themes.dark;
    let chart = chart(LegendPosition::Top, 4);
    let ring_paths = |list: &Deep2dRuntimeContent| -> Vec<(String, f64, Option<[f64; 4]>)> {
        match list {
            Deep2dRuntimeContent::DisplayList(list) => list
                .commands
                .iter()
                .filter_map(|command| match command {
                    deep_engine_native::deep2d::Deep2dCommand::Path(path)
                        if path.id.starts_with("legend.focus-ring") =>
                    {
                        Some((path.id.clone(), path.stroke_width?, path.stroke))
                    }
                    _ => None,
                })
                .collect(),
            _ => panic!("legend renders a display list"),
        }
    };
    let without_focus = {
        let mut list = deep_engine_native::deep2d::Deep2dDisplayList {
            schema_version: 1,
            id: "legend".into(),
            revision: chart.revision(),
            logical_width: 640.0,
            logical_height: 360.0,
            scale_factor: 1.0,
            resources: vec![],
            commands: vec![],
            atlases: vec![],
        };
        let mut rasterizer = TextRasterizer::new();
        append_legend(&mut list, &chart, &mut rasterizer, theme, 0, None).unwrap();
        ring_paths(&Deep2dRuntimeContent::DisplayList(list))
    };
    assert!(without_focus.is_empty(), "无焦点不得画环");
    let with_focus = {
        let mut list = deep_engine_native::deep2d::Deep2dDisplayList {
            schema_version: 1,
            id: "legend".into(),
            revision: chart.revision(),
            logical_width: 640.0,
            logical_height: 360.0,
            scale_factor: 1.0,
            resources: vec![],
            commands: vec![],
            atlases: vec![],
        };
        let mut rasterizer = TextRasterizer::new();
        append_legend(&mut list, &chart, &mut rasterizer, theme, 0, Some(1)).unwrap();
        ring_paths(&Deep2dRuntimeContent::DisplayList(list))
    };
    assert_eq!(with_focus.len(), 1, "焦点项恰一个环");
    let (_, stroke_width, stroke) = &with_focus[0];
    assert_eq!(*stroke_width, 2.0);
    assert!(stroke.is_some(), "环使用主题 accent 描边");
    // 越界焦点(项不存在)不画环也不报错。
    let out_of_range = {
        let mut list = deep_engine_native::deep2d::Deep2dDisplayList {
            schema_version: 1,
            id: "legend".into(),
            revision: chart.revision(),
            logical_width: 640.0,
            logical_height: 360.0,
            scale_factor: 1.0,
            resources: vec![],
            commands: vec![],
            atlases: vec![],
        };
        let mut rasterizer = TextRasterizer::new();
        append_legend(&mut list, &chart, &mut rasterizer, theme, 0, Some(99)).unwrap();
        ring_paths(&Deep2dRuntimeContent::DisplayList(list))
    };
    assert!(out_of_range.is_empty());
}
