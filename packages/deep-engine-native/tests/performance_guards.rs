//! Performance guards: loose wall-clock budgets that fail when an algorithm
//! regresses by an order of magnitude (e.g. accidental O(n²) in the hit
//! index or the layout solver). Thresholds are calibrated for a DEBUG build
//! on the reference machine so CI without optimization still passes; they
//! are regression tripwires, not benchmark claims.

use std::time::Instant;

use deep_engine_native::chart::{
    ChartAxis, ChartAxisChannel, ChartDataset, ChartIR, ChartScale, ChartSeries, ChartSeriesType,
    ChunkedSeries, MAX_RESIDENT_POINTS, render_chart,
};
use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, PathCommand, PathResource,
    build_hit_index,
};
use deep_engine_native::native_ui::retained_ui::{
    RetainedUiA11y, RetainedUiContent, RetainedUiPointerEvents, RetainedUiRole, RetainedUiTree,
};
use deep_engine_native::native_ui::{
    RetainedUiLayoutMode, RetainedUiNode, RetainedUiStyle, layout_tree,
};

fn style(x: f64, y: f64, w: f64, h: f64) -> RetainedUiStyle {
    RetainedUiStyle {
        layout: RetainedUiLayoutMode::Absolute,
        x,
        y,
        width: w,
        height: h,
        min_width: None,
        max_width: None,
        min_height: None,
        max_height: None,
        padding: 0.0,
        gap: 0.0,
        grow: 0.0,
        align: deep_engine_native::native_ui::RetainedUiAlign::Start,
        clip: false,
        visible: true,
        opacity: 1.0,
        pointer_events: RetainedUiPointerEvents::Auto,
        z_index: 0,
        background: None,
        foreground: [1.0; 4],
        border_color: None,
        border_width: 0.0,
        corner_radius: 0.0,
        font_id: None,
        font_size: 14.0,
    }
}

fn container(id: &str, parent: Option<&str>, x: f64, y: f64, w: f64, h: f64) -> RetainedUiNode {
    RetainedUiNode {
        id: id.into(),
        revision: 0,
        parent_id: parent.map(str::to_owned),
        children: Vec::new(),
        style: style(x, y, w, h),
        content: RetainedUiContent::Container,
        a11y: RetainedUiA11y {
            role: RetainedUiRole::Region,
            label: None,
            value: None,
        },
    }
}

#[test]
fn layout_tree_handles_ten_thousand_nodes_within_budget() {
    let node_count = 10_000;
    let mut nodes = vec![container("root", None, 0.0, 0.0, 1000.0, 1000.0)];
    for index in 0..node_count {
        nodes.push(container(
            &format!("n{index}"),
            Some("root"),
            (index % 50) as f64 * 10.0,
            (index / 50) as f64 * 10.0,
            10.0,
            10.0,
        ));
    }
    nodes[0].children = (0..node_count).map(|index| format!("n{index}")).collect();
    let tree = RetainedUiTree {
        schema_version: 1,
        id: "perf".into(),
        revision: 1,
        width: 1000.0,
        height: 1000.0,
        root_id: "root".into(),
        nodes,
    };
    let start = Instant::now();
    let layout = layout_tree(&tree).expect("deep tree lays out");
    let elapsed = start.elapsed();
    assert_eq!(layout.rects.len(), node_count + 1);
    assert!(
        elapsed.as_secs_f64() < 2.0,
        "10k-node layout took {elapsed:?} — algorithmic regression suspected"
    );
}

#[test]
fn hit_index_build_and_query_stay_subsecond_on_large_lists() {
    let mut commands = Vec::new();
    let command_count = 2_000;
    for index in 0..command_count {
        commands.push(Deep2dCommand::Path(PathCommand {
            id: format!("c{index}"),
            z_order: (index % 16) as i32,
            transform: [
                1.0,
                0.0,
                0.0,
                1.0,
                (index % 40) as f64 * 12.0,
                (index / 40) as f64 * 12.0,
            ],
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: Some(format!("hit-{index}")),
            path_id: "probe".into(),
            fill: Some([1.0, 1.0, 1.0, 1.0]),
            fill_rule: None,
            stroke: None,
            stroke_width: None,
            line_cap: None,
            line_join: None,
            miter_limit: None,
            dash: None,
            dash_offset: None,
        }));
    }
    let display_list = Deep2dDisplayList {
        schema_version: 1,
        id: "hit-perf".into(),
        revision: 1,
        logical_width: 1_000.0,
        logical_height: 1_000.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Path(PathResource {
            id: "probe".into(),
            revision: 1,
            verbs: vec![
                Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
                Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
                Deep2dPathVerb::Line { x: 10.0, y: 10.0 },
                Deep2dPathVerb::Line { x: 0.0, y: 10.0 },
                Deep2dPathVerb::Close,
            ],
        })],
        commands,
        atlases: Vec::new(),
    };
    let start = Instant::now();
    let index = build_hit_index(&display_list).expect("index builds");
    let build = start.elapsed();
    let query_start = Instant::now();
    let mut hits = 0usize;
    for step in 0..5_000 {
        let x = (step % 100) as f64 * 10.0;
        let y = (step / 100) as f64 * 10.0;
        if index.hit([x, y]).is_some() {
            hits += 1;
        }
    }
    let query = query_start.elapsed();
    assert_eq!(index.entries().len(), command_count);
    assert!(hits > 0, "grid points must land inside squares");
    assert!(
        build.as_secs_f64() < 2.0 && query.as_secs_f64() < 2.0,
        "hit index build {build:?} / 5k queries {query:?} — regression suspected"
    );
}

#[test]
fn render_chart_one_series_of_many_points_stays_bounded() {
    let points = 50_000;
    let rows = (0..points)
        .map(|i| {
            vec![
                serde_json::json!(i as f64),
                serde_json::json!((i as f64) * 0.5 % 100.0),
            ]
        })
        .collect::<Vec<_>>();
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "perf-line".into(),
        datasets: vec![ChartDataset {
            id: "d".into(),
            dimensions: vec!["x".into(), "y".into()],
            rows: rows.into(),
        }],
        axes: vec![
            ChartAxis {
                id: "x".into(),
                channel: ChartAxisChannel::X,
                scale: ChartScale::Linear,
                min: None,
                max: None,
            },
            ChartAxis {
                id: "y".into(),
                channel: ChartAxisChannel::Y,
                scale: ChartScale::Linear,
                min: None,
                max: None,
            },
        ],
        series: vec![ChartSeries {
            id: "s".into(),
            label: "series".into(),
            series_type: ChartSeriesType::Line,
            dataset_id: "d".into(),
            x: Some("x".into()),
            y: Some("y".into()),
            name: None,
            value: None,
            min: None,
            max: None,
            x_axis_id: Some("x".into()),
            y_axis_id: Some("y".into()),
        }],
        ..Default::default()
    };
    let start = Instant::now();
    let display_list = render_chart(&ir, 800.0, 600.0).expect("renders");
    let elapsed = start.elapsed();
    assert!(
        !display_list.commands.is_empty(),
        "line series must emit geometry"
    );
    assert!(
        elapsed.as_secs_f64() < 3.0,
        "50k-point line render took {elapsed:?} — regression suspected"
    );
}

#[test]
fn chunked_series_million_point_pipeline_stays_bounded() {
    let mut series = ChunkedSeries::with_chunk_size(deep_engine_native::chart::CHUNK_SIZE);
    let start = Instant::now();
    let chunk = vec![0.5f64; deep_engine_native::chart::CHUNK_SIZE];
    while series.len() + chunk.len() <= MAX_RESIDENT_POINTS {
        series.append(&chunk).expect("append chunk");
    }
    let append_elapsed = start.elapsed();
    assert_eq!(series.len(), MAX_RESIDENT_POINTS);

    let visible = series.visible_slice(0, MAX_RESIDENT_POINTS);
    let (drawn, accounting) = series.decimate(&visible, 2_000);
    let total = start.elapsed();
    assert_eq!(drawn.len(), 2_000, "decimation caps drawn points");
    assert_eq!(accounting.input_points, MAX_RESIDENT_POINTS);
    assert_eq!(accounting.dropped_points, MAX_RESIDENT_POINTS - 2_000);
    assert!(
        total.as_secs_f64() < 10.0,
        "1M-point append+slice+decimate took append={append_elapsed:?} total={total:?}"
    );
}

#[test]
fn render_chart_is_deterministic_across_calls() {
    let rows = vec![
        vec![serde_json::json!("a"), serde_json::json!(1.0)],
        vec![serde_json::json!("b"), serde_json::json!(3.0)],
        vec![serde_json::json!("c"), serde_json::json!(2.0)],
    ];
    let ir = ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "det".into(),
        datasets: vec![ChartDataset {
            id: "d".into(),
            dimensions: vec!["cat".into(), "v".into()],
            rows: rows.into(),
        }],
        axes: vec![ChartAxis {
            id: "x".into(),
            channel: ChartAxisChannel::X,
            scale: ChartScale::Category,
            min: None,
            max: None,
        }],
        series: vec![ChartSeries {
            id: "bar".into(),
            label: "柱".into(),
            series_type: ChartSeriesType::Bar,
            dataset_id: "d".into(),
            x: Some("cat".into()),
            y: Some("v".into()),
            name: None,
            value: None,
            min: None,
            max: None,
            x_axis_id: Some("x".into()),
            y_axis_id: None,
        }],
        ..Default::default()
    };
    let first = render_chart(&ir, 400.0, 300.0).expect("first render");
    let second = render_chart(&ir, 400.0, 300.0).expect("second render");
    let first = serde_json::to_string(&first).expect("serialize first");
    let second = serde_json::to_string(&second).expect("serialize second");
    assert_eq!(
        first, second,
        "identical IR must render byte-identical display lists (no HashMap iteration order)"
    );
}
