use deep_engine_native::chart::{
    ChartIR, ChartScale, parse_chart_ir, render_chart, render_chart_with_windows,
};
use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource,
};
use serde_json::json;

fn chart() -> ChartIR {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.series.retain(|series| series.id == "heat");
    ir.data_zoom.clear();
    ir.actions.clear();
    ir.legend.visible = false;
    ir.axes[1].scale = ChartScale::Category;
    ir.axes[1].min = None;
    ir.axes[1].max = None;
    ir.datasets[0].rows = vec![
        vec![json!("A"), json!("row1"), json!(0), json!("a")],
        vec![json!("B"), json!("row1"), json!(10), json!("b")],
        vec![json!("A"), json!("row2"), json!(20), json!("c")],
    ]
    .into();
    ir
}
fn rects(list: &Deep2dDisplayList) -> Vec<(f64, f64, f64, f64)> {
    list.resources
        .iter()
        .map(|resource| {
            let Deep2dResource::Path(path) = resource else {
                panic!("path")
            };
            let points = path
                .verbs
                .iter()
                .filter_map(|verb| match verb {
                    Deep2dPathVerb::Move { x, y } | Deep2dPathVerb::Line { x, y } => Some((*x, *y)),
                    _ => None,
                })
                .collect::<Vec<_>>();
            (
                points[0].0,
                points[0].1,
                points[2].0 - points[0].0,
                points[2].1 - points[0].1,
            )
        })
        .collect()
}
fn colors(list: &Deep2dDisplayList) -> Vec<Option<[f64; 4]>> {
    list.commands
        .iter()
        .map(|command| {
            let Deep2dCommand::Path(path) = command else {
                panic!("path")
            };
            path.fill
        })
        .collect()
}
#[test]
fn category_windows_expand_cells_without_changing_colors_or_source() {
    let ir = chart();
    let before = serde_json::to_value(&ir).unwrap();
    let full = render_chart(&ir, 216.0, 216.0).unwrap();
    let zoomed = render_chart_with_windows(
        &ir,
        216.0,
        216.0,
        &[],
        &[("x".into(), 0.0, 0.5), ("y".into(), 0.5, 1.0)],
    )
    .unwrap();
    assert_eq!(
        rects(&full),
        vec![
            (8.0, 8.0, 100.0, 100.0),
            (108.0, 8.0, 100.0, 100.0),
            (8.0, 108.0, 100.0, 100.0)
        ]
    );
    assert_eq!(
        rects(&zoomed),
        vec![
            (8.0, -192.0, 200.0, 200.0),
            (208.0, -192.0, 200.0, 200.0),
            (8.0, 8.0, 200.0, 200.0)
        ]
    );
    assert_eq!(colors(&full), colors(&zoomed));
    assert_eq!(serde_json::to_value(&ir).unwrap(), before);
}
#[test]
fn numeric_heatmap_respects_axis_bounds_and_logarithmic_cell_positions() {
    let mut ir = chart();
    ir.axes[0].scale = ChartScale::Log;
    ir.axes[0].min = Some(1.0);
    ir.axes[0].max = Some(1000.0);
    for (row, x) in ir.datasets[0].rows.iter_mut().zip([10, 100, 10]) {
        row[0] = json!(x);
    }
    let list = render_chart(&ir, 216.0, 216.0).unwrap();
    let rectangles = rects(&list);
    assert!((rectangles[0].0 - (8.0 + 100.0 / 3.0)).abs() < 1e-9);
    assert!((rectangles[1].0 - 108.0).abs() < 1e-9);
    assert!((rectangles[0].2 - 200.0 / 3.0).abs() < 1e-9);
    let zoomed =
        render_chart_with_windows(&ir, 216.0, 216.0, &[], &[("x".into(), 0.0, 0.5)]).unwrap();
    assert!((rects(&zoomed)[0].2 - 400.0 / 3.0).abs() < 1e-9);
    assert_eq!(colors(&list), colors(&zoomed));
}
