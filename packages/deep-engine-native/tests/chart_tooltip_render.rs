#[cfg(windows)]
use deep_engine_native::chart::tooltip_render::compose_tooltip;
use deep_engine_native::chart::tooltip_render::tooltip_rect;
#[cfg(windows)]
use deep_engine_native::chart::{ChartAction, ChartRuntime, parse_chart_ir};
#[cfg(windows)]
use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dResource, Deep2dRuntimeContent, prepare_runtime_content,
};
#[cfg(windows)]
use deep_engine_native::native_ui::design_tokens::DesignTokenSnapshot;
#[cfg(windows)]
use deep_engine_native::platform_text::TextRasterizer;

#[test]
fn tooltip_flips_and_stays_inside_canvas_at_all_edges() {
    for canvas in [[640.0, 360.0], [216.0, 216.0], [980.0, 480.0]] {
        for anchor in [[0.0, 0.0], canvas, [-200.0, 1000.0], [50.0, 50.0]] {
            let rect = tooltip_rect(canvas, anchor, [180.0, 90.0], 8.0).unwrap();
            assert!(rect[0] >= 8.0 && rect[1] >= 8.0);
            assert!(rect[0] + rect[2] <= canvas[0] - 8.0);
            assert!(rect[1] + rect[3] <= canvas[1] - 8.0);
        }
    }
    assert!(tooltip_rect([100.0; 2], [0.0; 2], [100.0; 2], 8.0).is_err());
    assert!(tooltip_rect([640.0, 360.0], [f64::NAN, 0.0], [180.0, 90.0], 8.0).is_err());
}

#[cfg(windows)]
#[test]
fn actual_tooltip_pixels_compose_in_both_themes_without_changing_hit_geometry() {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.tooltip.enabled = true;
    let mut chart = ChartRuntime::new(ir, 640.0, 360.0).unwrap();
    chart
        .dispatch(ChartAction::Hover {
            series_id: "scatter".into(),
            data_index: 0,
            x_label: "泵站 A".into(),
            value: "25.6°C".into(),
        })
        .unwrap();
    let source = serde_json::to_value(chart.frame().display_list()).unwrap();
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    let mut rasterizer = TextRasterizer::new();
    for theme in [&tokens.themes.dark, &tokens.themes.light] {
        let list = compose_tooltip(&chart, &mut rasterizer, theme, [635.0, 355.0]).unwrap();
        assert_eq!(
            list.commands.len(),
            chart.frame().display_list().commands.len() + 2
        );
        let Deep2dCommand::Image(label) = list.commands.last().unwrap() else {
            panic!("label")
        };
        assert_eq!(label.z_order, i32::MAX);
        assert!(label.hit_id.is_none());
        assert!(label.x + label.width <= 640.0 && label.y + label.height <= 360.0);
        let Deep2dCommand::Path(panel) = &list.commands[list.commands.len() - 2] else {
            panic!("panel")
        };
        assert_eq!(panel.fill, theme.colors.surface1);
        assert!(panel.hit_id.is_none());
        assert!(
            list.resources
                .iter()
                .any(|r| matches!(r, Deep2dResource::Image(_)))
        );
        prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(list)).unwrap();
    }
    let mut invalid = tokens.themes.dark.clone();
    invalid.colors.text_strong = Some([f64::NAN; 4]);
    assert!(compose_tooltip(&chart, &mut rasterizer, &invalid, [0.0; 2]).is_err());
    assert_eq!(
        serde_json::to_value(chart.frame().display_list()).unwrap(),
        source
    );
    chart.dispatch(ChartAction::HoverEnd).unwrap();
    let cleared = compose_tooltip(&chart, &mut rasterizer, &tokens.themes.dark, [0.0; 2]).unwrap();
    assert_eq!(
        cleared.commands.len(),
        chart.frame().display_list().commands.len()
    );
    assert!(cleared.atlases.is_empty());
}
