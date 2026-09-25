//! Presenter-layer axes + legend presentation: deterministic tick derivation
//! from ChartIR data, label quads riding the axis line, legend swatches, and
//! a committed golden fixture for the derived scalars.

use deep_engine_native::chart::{ChartAction, ChartRuntime, axis_render, parse_chart_ir};
use deep_engine_native::deep2d::Deep2dCommand;
use deep_engine_native::platform_text::TextRasterizer;
use deep_engine_native::runtime_package::runtime_content_sha256;
use serde_json::{Value, json};

fn source_ir() -> Value {
    json!({"schemaVersion":1,"sourceSpecVersion":1,"id":"axes-present",
        "datasets":[{"id":"d","dimensions":["category","value"],
            "rows":[["East",37],["North",91],["South",58]]}],
        "axes":[{"id":"axis.x","channel":"x","scale":"category","min":null,"max":null},
            {"id":"axis.y","channel":"y","scale":"linear","min":null,"max":null}],
        "series":[{"id":"series.0","label":"Regional output","type":"bar","datasetId":"d",
            "x":"category","y":"value","xAxisId":"axis.x","yAxisId":"axis.y"}],
        "legend":{"visible":true,"position":"top"},
        "tooltip":{"enabled":true,"trigger":"axis"},"dataZoom":[],"actions":[]})
}

fn runtime() -> ChartRuntime {
    let ir = parse_chart_ir(&serde_json::to_vec(&source_ir()).unwrap()).unwrap();
    ChartRuntime::new(ir, 440.0, 430.0).unwrap()
}

fn present(chart: &ChartRuntime) -> deep_engine_native::deep2d::Deep2dDisplayList {
    let mut rasterizer = TextRasterizer::new();
    deep_engine_native::chart::presentation::present_chart(
        chart,
        &mut rasterizer,
        0,
        [0.0, 0.0],
        None,
    )
    .unwrap()
}

/// Axis label image quads (the text channel), with their on-canvas rects.
fn label_quads(list: &deep_engine_native::deep2d::Deep2dDisplayList) -> Vec<(String, [f64; 4])> {
    list.commands
        .iter()
        .filter_map(|command| match command {
            Deep2dCommand::Image(image) if image.z_order == axis_render::AXIS_TEXT_Z => Some((
                image.id.clone(),
                [image.x, image.y, image.width, image.height],
            )),
            _ => None,
        })
        .collect()
}

/// Recomputes the command id the renderer derives from axis id + text +
/// position, so a quad id double-checks its exact label text.
fn label_id(axis_id: &str, text: &str, position: f64) -> String {
    let key = runtime_content_sha256(&serde_json::json!([
        "chart-axis-label",
        axis_id,
        text,
        position
    ]));
    format!(
        "draw-{}",
        runtime_content_sha256(&serde_json::json!([
            "text-image",
            format!("chart-axis.{key}")
        ]))
    )
}

fn axis_lines(
    list: &deep_engine_native::deep2d::Deep2dDisplayList,
) -> Vec<((f64, f64), (f64, f64))> {
    list.commands
        .iter()
        .filter_map(|command| {
            let deep_engine_native::deep2d::Deep2dCommand::Path(path) = command else {
                return None;
            };
            if path.z_order != axis_render::AXIS_LINE_Z {
                return None;
            }
            let resource = list.resources.iter().find_map(|resource| match resource {
                deep_engine_native::deep2d::Deep2dResource::Path(path_resource)
                    if path_resource.id == path.path_id =>
                {
                    Some(path_resource)
                }
                _ => None,
            })?;
            let points: Vec<(f64, f64)> = resource
                .verbs
                .iter()
                .filter_map(|verb| match verb {
                    deep_engine_native::deep2d::Deep2dPathVerb::Move { x, y }
                    | deep_engine_native::deep2d::Deep2dPathVerb::Line { x, y } => Some((*x, *y)),
                    _ => None,
                })
                .collect();
            points.first().zip(points.last()).map(|(a, b)| (*a, *b))
        })
        .collect()
}

fn scalar_view(list: &deep_engine_native::deep2d::Deep2dDisplayList) -> Value {
    let mut quads: Vec<Value> = label_quads(list)
        .into_iter()
        .map(|(id, rect)| {
            let rounded: Vec<f64> = rect
                .iter()
                .map(|value| (value * 100.0).round() / 100.0)
                .collect();
            json!({"id": id, "rect": rounded})
        })
        .collect();
    quads.sort_by(|a, b| a["id"].as_str().unwrap().cmp(b["id"].as_str().unwrap()));
    let mut lines: Vec<Value> = axis_lines(list)
        .into_iter()
        .map(|(from, to)| json!({"from":[from.0,from.1],"to":[to.0,to.1]}))
        .collect();
    lines.sort_by(|a, b| {
        serde_json::to_string(a)
            .unwrap()
            .cmp(&serde_json::to_string(b).unwrap())
    });
    json!({"labels":quads,"axisLines":lines})
}

#[test]
fn category_axis_labels_align_with_geometry_bands_and_match_golden() {
    let chart = runtime();
    let list = present(&chart);
    let quads = label_quads(&list);
    // East/North/South plus the numeric y ticks (domain 0..91 -> tens).
    let y_ticks = quads.len() - 3;
    assert!((4..=12).contains(&y_ticks), "y ticks {y_ticks}");
    let source = chart.source();
    let plot = deep_engine_native::chart::layout::layout_chart(source, 440.0, 430.0).unwrap();
    let pw = plot.plot[2];
    // Exact text identity: the id embeds the axis id and label text, so an
    // id match proves the right string was rasterized at that quad.
    for (row, expected) in ["East", "North", "South"].iter().enumerate() {
        let position = plot.plot[0] + (row as f64 + 0.5) / 3.0 * pw;
        let id = quads
            .iter()
            .find(|(_, rect)| (rect[0] + rect[2] * 0.5 - position).abs() < 1.0)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| panic!("no quad near band center {position}"));
        assert_eq!(
            id,
            label_id("axis.x", expected, position),
            "band {row} must carry the label {expected:?}"
        );
    }
    assert!(
        quads
            .iter()
            .any(|(id, _)| *id == label_id("axis.y", "0", plot.plot[1] + plot.plot[3]))
    );
    let view = scalar_view(&list);
    if let Some(path) = std::env::var_os("DEEP_CHART_AXES_GOLDEN_WRITE") {
        serde_json::to_writer_pretty(
            std::fs::File::create(path).unwrap(),
            &json!({"schemaVersion": 1, "cases": [{"name": "bar-category-440x430", "presented": view}]}),
        )
        .unwrap();
    }
    // Font raster metrics vary between the Windows Inter install and the
    // minimal Linux runner. Keep the exact golden guard on the desktop target;
    // the structural and identity assertions above remain cross-platform.
    #[cfg(windows)]
    if let Ok(fixture) = std::fs::read_to_string(
        std::env!("CARGO_MANIFEST_DIR").to_string()
            + "/tests/fixtures/chart-axes-legend-golden-v1.json",
    ) {
        let fixture: Value = serde_json::from_str(&fixture).unwrap();
        assert_eq!(view, fixture["cases"][0]["presented"], "golden drift");
    }
}

#[test]
fn axis_lines_draw_at_the_plot_edges() {
    let chart = runtime();
    let list = present(&chart);
    let lines = axis_lines(&list);
    let plot = deep_engine_native::chart::layout::layout_chart(chart.source(), 440.0, 430.0)
        .unwrap()
        .plot;
    let bottom = plot[1] + plot[3];
    let left = plot[0];
    assert!(
        lines.iter().any(|(from, to)| {
            (from.1 - bottom).abs() < 0.5 && (to.1 - bottom).abs() < 0.5 && to.0 - from.0 > 100.0
        }),
        "x axis line"
    );
    assert!(
        lines.iter().any(|(from, to)| {
            (from.0 - left).abs() < 0.5
                && (to.0 - left).abs() < 0.5
                && (from.1 - to.1).abs() > 100.0
        }),
        "y axis line"
    );
}

#[test]
fn legend_semantics_follow_the_chart_ir_visibility() {
    let chart = runtime();
    let visible = present(&chart);
    assert!(visible.commands.iter().any(|command| matches!(command,
            Deep2dCommand::Image(image) if image.z_order == i32::MAX - 2)));
    // Swatch chips: path fills at the legend layer.
    assert!(visible.commands.iter().any(|command| matches!(command,
            Deep2dCommand::Path(path) if path.z_order == i32::MAX - 2
                && path.fill.is_some()
                && path.id.starts_with("legend.swatch"))));

    let mut hidden_source = chart.source().clone();
    hidden_source.legend.visible = false;
    let mut hidden_chart = chart.clone();
    hidden_chart.replace(hidden_source).unwrap();
    let hidden = present(&hidden_chart);
    assert!(!hidden.commands.iter().any(|command| matches!(command,
            Deep2dCommand::Path(path) if path.id.starts_with("legend.swatch"))));
    // Axes still render when the legend is off (producer package semantics).
    assert!(!label_quads(&hidden).is_empty());
}

#[test]
fn zoom_windows_shift_category_labels_deterministically() {
    let mut chart = runtime();
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "axis.x".into(),
            start: 1.0 / 3.0,
            end: 1.0,
        })
        .unwrap();
    let list = present(&chart);
    let quads = label_quads(&list);
    let plot = deep_engine_native::chart::layout::layout_chart(chart.source(), 440.0, 430.0)
        .unwrap()
        .plot;
    // Row 0 maps outside the zoomed window and must be dropped; rows 1 and 2
    // survive with exactly the right text and windowed band centers.
    assert!(
        !quads
            .iter()
            .any(|(id, _)| *id == label_id("axis.x", "East", plot[0] - 0.25 * plot[2]))
    );
    let x_labels: Vec<_> = quads
        .iter()
        .filter(|(id, _)| {
            *id == label_id("axis.x", "North", plot[0] + 0.25 * plot[2])
                || *id == label_id("axis.x", "South", plot[0] + 0.75 * plot[2])
        })
        .collect();
    assert_eq!(x_labels.len(), 2, "zoomed window keeps two category labels");
    let (px, pw) = (plot[0], plot[2]);
    // first=1, span=2 over 3 rows: visible band centers at 1.5 and 2.5.
    for (index, expected_center) in [(0usize, px + 0.25 * pw), (1, px + 0.75 * pw)] {
        assert!(
            (x_labels[index].1[0] + x_labels[index].1[2] * 0.5 - expected_center).abs() < 1.0,
            "label {index} center must sit at {expected_center}"
        );
    }
}
