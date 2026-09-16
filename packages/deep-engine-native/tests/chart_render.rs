//! Chart renderer integration tests (C03): six series types on real data,
//! every output re-validated against the Deep2d display list contract.

use deep_engine_native::chart::render::render_chart;
use deep_engine_native::chart::{
    ChartAxis, ChartAxisChannel, ChartDataset, ChartIR, ChartScale, ChartSeries, ChartSeriesType,
};
use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dPathVerb, Deep2dResource, PathCommand, validate_display_list,
};

const CANVAS: (f64, f64) = (480.0, 320.0);
const LINE_COLOR: [f64; 4] = [0.2, 0.6, 1.0, 1.0];
const BAR_COLOR: [f64; 4] = [0.2, 0.8, 0.4, 1.0];
const SCATTER_COLOR: [f64; 4] = [1.0, 0.8, 0.2, 1.0];
const GAUGE_COLOR: [f64; 4] = [0.5, 0.7, 1.0, 1.0];
const NEEDLE_COLOR: [f64; 4] = [1.0, 1.0, 1.0, 1.0];
const HEAT_COLD: [f64; 4] = [0.1, 0.2, 0.8, 1.0];
const HEAT_HOT: [f64; 4] = [0.9, 0.2, 0.1, 1.0];
const PIE_PALETTE: [[f64; 4]; 6] = [
    [0.33, 0.44, 0.78, 1.0],
    [0.57, 0.8, 0.46, 1.0],
    [0.98, 0.78, 0.35, 1.0],
    [0.93, 0.4, 0.4, 1.0],
    [0.45, 0.75, 0.87, 1.0],
    [0.23, 0.64, 0.45, 1.0],
];

// ------------------------------------------------------------ IR fixtures ---

fn axis(id: &str, channel: ChartAxisChannel, min: Option<f64>, max: Option<f64>) -> ChartAxis {
    ChartAxis {
        id: id.into(),
        channel,
        scale: ChartScale::Linear,
        min,
        max,
    }
}

fn dataset(id: &str, dimensions: &[&str], rows: Vec<Vec<serde_json::Value>>) -> ChartDataset {
    ChartDataset {
        id: id.into(),
        dimensions: dimensions.iter().map(|d| d.to_string()).collect(),
        rows: rows.into(),
    }
}

fn cartesian(id: &str, series_type: ChartSeriesType, dataset_id: &str) -> ChartSeries {
    ChartSeries {
        id: id.into(),
        label: id.into(),
        series_type,
        dataset_id: dataset_id.into(),
        x: Some("x".into()),
        y: Some("y".into()),
        name: None,
        value: None,
        min: None,
        max: None,
        x_axis_id: Some("x".into()),
        y_axis_id: Some("y".into()),
    }
}

fn name_value_series(
    id: &str,
    series_type: ChartSeriesType,
    min: Option<f64>,
    max: Option<f64>,
) -> ChartSeries {
    ChartSeries {
        id: id.into(),
        label: id.into(),
        series_type,
        dataset_id: format!("{id}-data"),
        x: None,
        y: None,
        name: Some("name".into()),
        value: Some("value".into()),
        min,
        max,
        x_axis_id: None,
        y_axis_id: None,
    }
}

fn heatmap_series() -> ChartSeries {
    ChartSeries {
        id: "heat".into(),
        label: "heat".into(),
        series_type: ChartSeriesType::Heatmap,
        dataset_id: "heat-data".into(),
        x: Some("x".into()),
        y: Some("y".into()),
        name: None,
        value: Some("value".into()),
        min: None,
        max: None,
        x_axis_id: None,
        y_axis_id: None,
    }
}

// ------------------------------------------------------------ test helpers ---

fn path_of(command: &Deep2dCommand) -> &PathCommand {
    match command {
        Deep2dCommand::Path(path) => path,
        _ => panic!("renderer must only emit path commands, got {command:?}"),
    }
}

fn paths(dl: &deep_engine_native::deep2d::Deep2dDisplayList) -> Vec<&PathCommand> {
    dl.commands.iter().map(path_of).collect()
}

fn assert_self_validated(dl: &deep_engine_native::deep2d::Deep2dDisplayList) {
    let validation = validate_display_list(dl);
    assert!(validation.valid, "deep2d issues: {:?}", validation.issues);
    assert!(
        dl.commands
            .iter()
            .all(|c| matches!(c, Deep2dCommand::Path(_)))
    );
}

fn assert_within_canvas(
    dl: &deep_engine_native::deep2d::Deep2dDisplayList,
    width: f64,
    height: f64,
) {
    for resource in &dl.resources {
        let Deep2dResource::Path(path) = resource else {
            panic!("only path resources expected");
        };
        for verb in &path.verbs {
            let coords: Vec<f64> = match verb {
                Deep2dPathVerb::Move { x, y } | Deep2dPathVerb::Line { x, y } => vec![*x, *y],
                Deep2dPathVerb::Close => continue,
                other => panic!("renderer only emits move/line/close, got {other:?}"),
            };
            assert!(
                coords
                    .iter()
                    .all(|v| v.is_finite() && *v >= 0.0 && *v <= 16_777_216.0),
                "verb out of contract: {verb:?}"
            );
            assert!(
                coords[0] <= width && coords[1] <= height,
                "verb outside canvas: {verb:?}"
            );
        }
    }
}

fn assert_point_close(verb: &Deep2dPathVerb, expected: (f64, f64), tolerance: f64) {
    let Deep2dPathVerb::Line { x, y } = verb else {
        panic!("expected a line verb, got {verb:?}");
    };
    assert!(
        (x - expected.0).abs() < tolerance && (y - expected.1).abs() < tolerance,
        "expected ({expected:?})±{tolerance}, got ({x}, {y})"
    );
}

// ------------------------------------------------------------------- line ---

#[test]
fn line_series_renders_stroke_polyline() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "trend".into(),
        datasets: vec![dataset(
            "d",
            &["x", "y"],
            vec![
                vec![serde_json::json!(1), serde_json::json!(10.5)],
                vec![serde_json::json!(2), serde_json::json!(20.0)],
                vec![serde_json::json!(3), serde_json::json!(30.0)],
            ],
        )],
        axes: vec![
            axis("x", ChartAxisChannel::X, None, None),
            axis("y", ChartAxisChannel::Y, Some(0.0), Some(30.0)),
        ],
        series: vec![cartesian("s", ChartSeriesType::Line, "d")],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_eq!(dl.id, "trend", "ASCII IR id survives sanitization");
    assert_eq!(dl.logical_width, CANVAS.0);
    assert_eq!(dl.scale_factor, 1.0);
    assert_self_validated(&dl);
    assert_within_canvas(&dl, CANVAS.0, CANVAS.1);
    let commands = paths(&dl);
    assert_eq!(commands.len(), 1);
    let line = commands[0];
    assert_eq!(line.stroke, Some(LINE_COLOR));
    assert_eq!(line.stroke_width, Some(2.0));
    assert_eq!(line.fill, None);
    assert_eq!(line.z_order, 0);
    let resource = dl.resources.first().expect("path resource");
    let Deep2dResource::Path(path) = resource else {
        panic!("path resource expected");
    };
    assert_eq!(path.verbs.len(), 3, "move + two line segments");
    assert!(matches!(path.verbs[0], Deep2dPathVerb::Move { .. }));
    // verbs[1] is the second data point: x=2 of domain (1,3) → plot center
    // 240; y=20 of (0,30) → 312 - 2/3 × 280 = 125.33.
    assert_point_close(&path.verbs[1], (240.0, 312.0 - (20.0 / 30.0) * 280.0), 0.01);
}

// -------------------------------------------------------------------- bar ---

#[test]
fn bar_series_renders_filled_rects_and_skips_zero_height_bars() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "bars".into(),
        datasets: vec![dataset(
            "d",
            &["x", "y"],
            vec![
                vec![serde_json::json!("一月"), serde_json::json!(10.0)],
                vec![serde_json::json!("二月"), serde_json::json!(0.0)],
                vec![serde_json::json!("三月"), serde_json::json!(30.0)],
            ],
        )],
        axes: vec![
            axis("x", ChartAxisChannel::X, None, None),
            axis("y", ChartAxisChannel::Y, None, None),
        ],
        series: vec![cartesian("s", ChartSeriesType::Bar, "d")],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_self_validated(&dl);
    assert_within_canvas(&dl, CANVAS.0, CANVAS.1);
    // 零高度条会退化为退化多边形,被跳过;字符串 x 列退化为按行索引分带。
    let commands = paths(&dl);
    assert_eq!(commands.len(), 2, "zero-height bar skipped");
    for bar in &commands {
        assert_eq!(bar.fill, Some(BAR_COLOR));
        assert_eq!(bar.stroke, None);
        let resource = dl
            .resources
            .iter()
            .find(|r| path_id_of(r) == bar.path_id)
            .expect("bar resource");
        let Deep2dResource::Path(path) = resource else {
            panic!();
        };
        assert_eq!(path.verbs.len(), 5, "closed rect: move + 3 lines + close");
        assert!(matches!(path.verbs.last(), Some(Deep2dPathVerb::Close)));
    }
}

fn path_id_of(resource: &Deep2dResource) -> &str {
    match resource {
        Deep2dResource::Path(path) => &path.id,
        _ => panic!("path resource expected"),
    }
}

// ---------------------------------------------------------------- scatter ---

#[test]
fn scatter_series_renders_an_octagon_per_point() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "dots".into(),
        datasets: vec![dataset(
            "d",
            &["x", "y"],
            vec![
                vec![serde_json::json!(1), serde_json::json!(5.0)],
                vec![serde_json::json!(2), serde_json::json!(15.0)],
                vec![serde_json::json!(3), serde_json::json!(25.0)],
            ],
        )],
        axes: vec![
            axis("x", ChartAxisChannel::X, None, None),
            axis("y", ChartAxisChannel::Y, Some(0.0), Some(30.0)),
        ],
        series: vec![cartesian("s", ChartSeriesType::Scatter, "d")],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_self_validated(&dl);
    assert_within_canvas(&dl, CANVAS.0, CANVAS.1);
    let commands = paths(&dl);
    assert_eq!(commands.len(), 3, "one marker per point");
    for marker in &commands {
        assert_eq!(marker.fill, Some(SCATTER_COLOR));
        let resource = dl
            .resources
            .iter()
            .find(|r| path_id_of(r) == marker.path_id)
            .expect("marker resource");
        let Deep2dResource::Path(path) = resource else {
            panic!();
        };
        assert_eq!(
            path.verbs.len(),
            9,
            "8-segment octagon: move + 7 lines + close"
        );
    }
}

// -------------------------------------------------------------------- pie ---

#[test]
fn pie_series_splits_value_share_clockwise_from_top() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "share".into(),
        datasets: vec![dataset(
            "pie-data",
            &["name", "value"],
            vec![
                vec![serde_json::json!("A"), serde_json::json!(30.0)],
                vec![serde_json::json!("B"), serde_json::json!(20.0)],
                vec![serde_json::json!("C"), serde_json::json!(50.0)],
            ],
        )],
        axes: vec![],
        series: vec![name_value_series("pie", ChartSeriesType::Pie, None, None)],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_self_validated(&dl);
    assert_within_canvas(&dl, CANVAS.0, CANVAS.1);
    let commands = paths(&dl);
    assert_eq!(commands.len(), 3, "one wedge per row");
    for (index, wedge) in commands.iter().enumerate() {
        assert_eq!(
            wedge.fill,
            Some(PIE_PALETTE[index]),
            "wedge {index} color ring"
        );
        let resource = dl
            .resources
            .iter()
            .find(|r| path_id_of(r) == wedge.path_id)
            .expect("wedge resource");
        let Deep2dResource::Path(path) = resource else {
            panic!();
        };
        assert!(matches!(path.verbs.last(), Some(Deep2dPathVerb::Close)));
    }
    // 12 o'clock start (-90°): wedge A (108° sweep, 8 arc segments) second
    // vertex sits at -76.5°; center (240, 172), radius min(464,280)/2 - 4 = 136.
    let resource = dl
        .resources
        .iter()
        .find(|r| path_id_of(r) == commands[0].path_id)
        .expect("wedge resource");
    let Deep2dResource::Path(path) = resource else {
        panic!();
    };
    assert!(matches!(path.verbs[0], Deep2dPathVerb::Move { .. }));
    // verbs[1] = arc start at -90° (12 o'clock, (240, 172-136)); verbs[2] =
    // first arc step at -76.5° (sweep 108° over 8 segments).
    assert_point_close(&path.verbs[1], (240.0, 172.0 - 136.0), 0.01);
    assert_point_close(
        &path.verbs[2],
        (240.0 + 136.0 * 0.2334454, 172.0 - 136.0 * 0.9723699),
        0.05,
    );
}

#[test]
fn pie_series_full_circle_single_value_and_negative_values() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "ring".into(),
        datasets: vec![dataset(
            "pie-data",
            &["name", "value"],
            vec![
                vec![serde_json::json!("only"), serde_json::json!(42.0)],
                vec![serde_json::json!("skip"), serde_json::json!(-5.0)],
                vec![serde_json::json!("skip"), serde_json::json!(0.0)],
            ],
        )],
        axes: vec![],
        series: vec![name_value_series("pie", ChartSeriesType::Pie, None, None)],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_self_validated(&dl);
    // 负值/零值不产生扇形;唯一正值占满整圆 → 24 边形(无中心点,无重复端点)。
    let commands = paths(&dl);
    assert_eq!(commands.len(), 1);
    let resource = dl
        .resources
        .iter()
        .find(|r| path_id_of(r) == commands[0].path_id)
        .expect("ring resource");
    let Deep2dResource::Path(path) = resource else {
        panic!();
    };
    assert_eq!(path.verbs.len(), 25, "move + 24 ring lines + close");
}

// ---------------------------------------------------------------- heatmap ---

#[test]
fn heatmap_cells_map_values_onto_blue_red_ramp() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "heat".into(),
        datasets: vec![dataset(
            "heat-data",
            &["x", "y", "value"],
            vec![
                vec![
                    serde_json::json!("a"),
                    serde_json::json!("p"),
                    serde_json::json!(0.0),
                ],
                vec![
                    serde_json::json!("b"),
                    serde_json::json!("p"),
                    serde_json::json!(15.0),
                ],
                vec![
                    serde_json::json!("a"),
                    serde_json::json!("q"),
                    serde_json::json!(5.0),
                ],
                vec![
                    serde_json::json!("b"),
                    serde_json::json!("q"),
                    serde_json::json!(10.0),
                ],
            ],
        )],
        axes: vec![],
        series: vec![heatmap_series()],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_self_validated(&dl);
    assert_within_canvas(&dl, CANVAS.0, CANVAS.1);
    let commands = paths(&dl);
    assert_eq!(commands.len(), 4, "one cell per row");
    let fills: Vec<[f64; 4]> = commands.iter().filter_map(|c| c.fill).collect();
    // 色带端点是浮点插值结果,用近似比较而非精确相等。
    let color_approx =
        |a: [f64; 4], b: [f64; 4]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9);
    assert!(
        fills.iter().any(|f| color_approx(*f, HEAT_COLD)),
        "coldest cell: {fills:?}"
    );
    assert!(
        fills.iter().any(|f| color_approx(*f, HEAT_HOT)),
        "hottest cell: {fills:?}"
    );
    let mut sorted = fills.clone();
    sorted.sort_by(|a, b| a[0].total_cmp(&b[0]));
    assert!(
        sorted.windows(2).all(|pair| pair[0][0] < pair[1][0]),
        "ramp covers cold→hot: {sorted:?}"
    );
    // First cell (first-appearance band order) sits at the plot origin with
    // 2×2 banding: 232 × 128.
    let resource = dl
        .resources
        .iter()
        .find(|r| path_id_of(r) == commands[0].path_id)
        .expect("cell resource");
    let Deep2dResource::Path(path) = resource else {
        panic!();
    };
    match &path.verbs[0] {
        Deep2dPathVerb::Move { x, y } => assert_eq!((*x, *y), (8.0, 32.0)),
        other => panic!("move expected, got {other:?}"),
    }
}

#[test]
fn degenerate_and_extreme_cartesian_rows_stay_painter_safe() {
    let ir = |rows: Vec<Vec<serde_json::Value>>| ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "edge".into(),
        datasets: vec![dataset("d", &["x", "y"], rows)],
        axes: vec![
            axis("x", ChartAxisChannel::X, None, None),
            axis("y", ChartAxisChannel::Y, None, None),
        ],
        series: vec![cartesian("s", ChartSeriesType::Line, "d")],
        ..Default::default()
    };

    // 单点折线:painter 要求每条子路径 ≥2 个不同点 → 渲染为空几何。
    let single = ir(vec![vec![serde_json::json!(1), serde_json::json!(10.0)]]);
    let dl = render_chart(&single, CANVAS.0, CANVAS.1).expect("single point must not error");
    assert_self_validated(&dl);
    assert!(dl.commands.is_empty(), "single-point line → empty geometry");

    // 极大坐标:1e300 的 y 值被钳制进画布,显示列表依然有效。
    let huge = ir(vec![
        vec![serde_json::json!(1), serde_json::json!(1e300)],
        vec![serde_json::json!(2), serde_json::json!(-1e300)],
    ]);
    let dl = render_chart(&huge, CANVAS.0, CANVAS.1).expect("huge values must not error");
    assert_self_validated(&dl);
    assert_within_canvas(&dl, CANVAS.0, CANVAS.1);
}

// ------------------------------------------------------------------ gauge ---

#[test]
fn gauge_renders_270_degree_band_and_value_needle() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "load".into(),
        datasets: vec![dataset(
            "gauge-data",
            &["name", "value"],
            vec![vec![serde_json::json!("负载"), serde_json::json!(72.0)]],
        )],
        axes: vec![],
        series: vec![name_value_series(
            "gauge",
            ChartSeriesType::Gauge,
            Some(0.0),
            Some(100.0),
        )],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_self_validated(&dl);
    assert_within_canvas(&dl, CANVAS.0, CANVAS.1);
    let commands = paths(&dl);
    assert_eq!(commands.len(), 2, "band + needle");
    assert_eq!(commands[0].fill, Some(GAUGE_COLOR));
    // 270° band: outer 18 segments + inner 18 segments, single closed subpath.
    let band = dl
        .resources
        .iter()
        .find(|r| path_id_of(r) == commands[0].path_id)
        .expect("band resource");
    let Deep2dResource::Path(band_path) = band else {
        panic!();
    };
    assert_eq!(
        band_path.verbs.len(),
        39,
        "move + 18 outer + move + 18 inner + close"
    );
    assert!(matches!(
        band_path.verbs.last(),
        Some(Deep2dPathVerb::Close)
    ));
    // Needle at t=0.72 → angle 135° + 194.4° = 329.4°; center (240,172),
    // radius min(464,280)/2 - 8 = 132, needle length 0.8 × 132 = 105.6.
    let needle = commands[1];
    assert_eq!(needle.stroke, Some(NEEDLE_COLOR));
    assert_eq!(needle.stroke_width, Some(2.0));
    let resource = dl
        .resources
        .iter()
        .find(|r| path_id_of(r) == needle.path_id)
        .expect("needle resource");
    let Deep2dResource::Path(needle_path) = resource else {
        panic!();
    };
    assert_eq!(needle_path.verbs.len(), 2, "move + line");
    assert_point_close(
        &needle_path.verbs[1],
        (240.0 + 105.6 * 0.8607420, 172.0 - 105.6 * 0.5090414),
        0.05,
    );
}

// -------------------------------------------------------- empty / fail-safe ---

#[test]
fn empty_and_broken_series_render_without_error() {
    let cases = vec![
        cartesian("s", ChartSeriesType::Line, "empty-data"),
        cartesian("s", ChartSeriesType::Bar, "empty-data"),
        cartesian("s", ChartSeriesType::Scatter, "empty-data"),
        name_value_series("pie", ChartSeriesType::Pie, None, None),
        heatmap_series(),
    ];
    for mut series in cases {
        series.dataset_id = "empty-data".into();
        let ir = ChartIR {
            schema_version: 1,
            source_spec_version: 1,
            id: "empty".into(),
            datasets: vec![dataset("empty-data", &["x", "y"], vec![])],
            axes: vec![],
            series: vec![series],
            ..Default::default()
        };
        let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("empty data must not error");
        assert_self_validated(&dl);
        assert!(dl.commands.is_empty(), "empty data → empty geometry");
    }

    // 空数据 gauge 仍画刻度带(纯比例尺,不依赖数据行),但无指针。
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "empty-gauge".into(),
        datasets: vec![dataset("gauge-data", &["name", "value"], vec![])],
        axes: vec![],
        series: vec![name_value_series(
            "gauge",
            ChartSeriesType::Gauge,
            Some(0.0),
            Some(100.0),
        )],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("gauge without rows must not error");
    assert_self_validated(&dl);
    assert_eq!(dl.commands.len(), 1, "band only, no needle");

    // 引用不存在 dataset 的 series 被跳过,不 panic。
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "ghost".into(),
        datasets: vec![],
        axes: vec![],
        series: vec![cartesian("s", ChartSeriesType::Line, "ghost-data")],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("missing dataset must not error");
    assert_self_validated(&dl);
    assert!(dl.commands.is_empty());
}

// --------------------------------------------------------------- composite ---

#[test]
fn all_six_types_in_one_ir_validate_together() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "dashboard.温度/v1".into(),
        datasets: vec![
            dataset(
                "cartesian",
                &["x", "y"],
                vec![
                    vec![serde_json::json!(1), serde_json::json!(10.0)],
                    vec![serde_json::json!(2), serde_json::json!(20.0)],
                ],
            ),
            dataset(
                "pie-data",
                &["name", "value"],
                vec![
                    vec![serde_json::json!("A"), serde_json::json!(60.0)],
                    vec![serde_json::json!("B"), serde_json::json!(40.0)],
                ],
            ),
            dataset(
                "gauge-data",
                &["name", "value"],
                vec![vec![serde_json::json!("负载"), serde_json::json!(50.0)]],
            ),
            dataset(
                "heat-data",
                &["x", "y", "value"],
                vec![vec![
                    serde_json::json!("a"),
                    serde_json::json!("p"),
                    serde_json::json!(7.0),
                ]],
            ),
        ],
        axes: vec![
            axis("x", ChartAxisChannel::X, None, None),
            axis("y", ChartAxisChannel::Y, Some(0.0), Some(30.0)),
        ],
        series: vec![
            cartesian("line", ChartSeriesType::Line, "cartesian"),
            cartesian("bar", ChartSeriesType::Bar, "cartesian"),
            cartesian("scatter", ChartSeriesType::Scatter, "cartesian"),
            name_value_series("pie", ChartSeriesType::Pie, None, None),
            heatmap_series(),
            name_value_series("gauge", ChartSeriesType::Gauge, Some(0.0), Some(100.0)),
        ],
        ..Default::default()
    };
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_self_validated(&dl);
    assert_within_canvas(&dl, CANVAS.0, CANVAS.1);
    // z_order 密集递增;命令 id 唯一。
    let ids: Vec<&str> = dl
        .commands
        .iter()
        .map(|c| match c {
            Deep2dCommand::Path(p) => p.id.as_str(),
            _ => panic!("path only"),
        })
        .collect();
    let mut unique = ids.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(ids.len(), unique.len(), "command ids must be unique");
    // line 1 + bar 2 + scatter 2 + pie 2 + heat 1 + gauge 2 = 10
    assert_eq!(dl.commands.len(), 10);
}

// ------------------------------------------------------------------ fail ---

#[test]
fn render_fails_closed_on_invalid_canvas_and_sanitizes_ids() {
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "温度趋势".into(),
        datasets: vec![],
        axes: vec![],
        series: vec![],
        ..Default::default()
    };
    for (width, height) in [(0.0, 100.0), (100.0, -5.0), (f64::NAN, 100.0), (2e7, 100.0)] {
        assert!(
            render_chart(&ir, width, height).is_err(),
            "({width}, {height}) must fail"
        );
    }

    // 非 ASCII IR id 无法成为 Deep2d id → 回落到 "chart"。
    let dl = render_chart(&ir, CANVAS.0, CANVAS.1).expect("render");
    assert_self_validated(&dl);
    assert_eq!(dl.id, "chart");
    assert!(dl.commands.is_empty(), "no series → no geometry");
}
