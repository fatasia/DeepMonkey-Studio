use deep_engine_native::chart::ChartIR;
use deep_engine_native::chart::interaction_contract::LegendPosition;
use deep_engine_native::chart::layout::{LEGEND_BAND_HEIGHT, PADDING, layout_chart};
const CANVAS: (f64, f64) = (480.0, 320.0);

// ----------------------------------------------------------------- layout ---

#[test]
fn layout_reserves_legend_band_and_plot_padding() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "layout".into(),
        datasets: vec![],
        axes: vec![],
        series: vec![],
        ..Default::default()
    };
    let frame = layout_chart(&ir, CANVAS.0, CANVAS.1).expect("valid canvas");
    // 默认配置与 TS 一致：顶部显示图例。
    assert_eq!(
        frame.legend,
        Some([
            PADDING,
            PADDING,
            CANVAS.0 - PADDING * 2.0,
            LEGEND_BAND_HEIGHT
        ])
    );
    assert_eq!(
        frame.plot,
        [PADDING, PADDING + LEGEND_BAND_HEIGHT, 464.0, 280.0]
    );
    assert_eq!(frame.title, None, "IR v1 has no title source");
}

#[test]
fn layout_consumes_every_legend_position_and_visibility() {
    let mut ir = ChartIR::default();
    for (position, plot, legend) in [
        (
            LegendPosition::Top,
            [8.0, 32.0, 464.0, 280.0],
            [8.0, 8.0, 464.0, 24.0],
        ),
        (
            LegendPosition::Bottom,
            [8.0, 8.0, 464.0, 280.0],
            [8.0, 288.0, 464.0, 24.0],
        ),
        (
            LegendPosition::Left,
            [128.0, 8.0, 344.0, 304.0],
            [8.0, 8.0, 120.0, 304.0],
        ),
        (
            LegendPosition::Right,
            [8.0, 8.0, 344.0, 304.0],
            [352.0, 8.0, 120.0, 304.0],
        ),
    ] {
        ir.legend.position = position;
        ir.legend.visible = true;
        let frame = layout_chart(&ir, 480.0, 320.0).unwrap();
        assert_eq!(frame.plot, plot);
        assert_eq!(frame.legend, Some(legend));
        ir.legend.visible = false;
        let hidden = layout_chart(&ir, 480.0, 320.0).unwrap();
        assert_eq!(hidden.plot, [8.0, 8.0, 464.0, 304.0]);
        assert_eq!(hidden.legend, None);
        assert!(layout_chart(&ir, 17.0, 17.0).is_ok());
        assert!(layout_chart(&ir, 16.0, 17.0).is_err());
    }
}

#[test]
fn side_legend_rejects_canvas_without_plot_space() {
    let mut ir = ChartIR::default();
    for position in [LegendPosition::Left, LegendPosition::Right] {
        ir.legend.position = position;
        assert!(layout_chart(&ir, 136.0, 320.0).is_err());
        assert!(layout_chart(&ir, 137.0, 17.0).is_ok());
        assert!(layout_chart(&ir, 137.0, 16.0).is_err());
    }
}

#[test]
fn hidden_legend_changes_actual_rendered_geometry() {
    let mut ir = deep_engine_native::chart::parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.legend.visible = true;
    ir.legend.position = LegendPosition::Top;
    let with_legend = deep_engine_native::chart::render_chart(&ir, 480.0, 320.0).unwrap();
    ir.legend.visible = false;
    let without_legend = deep_engine_native::chart::render_chart(&ir, 480.0, 320.0).unwrap();
    assert!(!with_legend.resources.is_empty());
    assert_ne!(
        serde_json::to_value(&with_legend.resources).unwrap(),
        serde_json::to_value(&without_legend.resources).unwrap()
    );
    assert_eq!(with_legend.commands.len(), without_legend.commands.len());
}

#[test]
fn layout_fails_closed_on_unusable_canvas() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "layout".into(),
        datasets: vec![],
        axes: vec![],
        series: vec![],
        ..Default::default()
    };
    for (width, height) in [
        (0.0, 320.0),
        (480.0, 0.0),
        (-1.0, 320.0),
        (f64::NAN, 320.0),
        (f64::INFINITY, 320.0),
        // Deep2d logical size budget is 16_777_216.
        (16_777_217.0, 320.0),
        // 24px legend band + 2×8px padding leave no positive plot area.
        (480.0, 39.0),
        (16.0, 320.0),
    ] {
        let error = layout_chart(&ir, width, height)
            .err()
            .unwrap_or_else(|| panic!("({width}, {height}) must fail closed"));
        assert!(!error.is_empty());
    }
    // Exactly at the minimum viable size passes.
    assert!(layout_chart(&ir, 17.0, 41.0).is_ok());
}
