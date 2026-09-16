//! U09: composable prototype frame builder. Assembles the native shell —
//! top bar, object tree with selection, inspector controls, chart strip —
//! into ONE Deep2D display list that flows through the production painter
//! on the same device/queue as the 3D pass. No window code lives here; the
//! winit shell (P1 lane) drives state and calls this each dirty frame.

use crate::chart::{ChartIR, render_chart};
use crate::deep2d::{Deep2dCommand, Deep2dDisplayList, PathCommand, PathResource};
use crate::native_ui::control_render::{
    ControlCanvas, ControlPalette, PaintContext, render_button, render_checkbox, render_slider,
};

/// Frame state the window shell owns; the builder is a pure function of it.
#[derive(Debug, Clone)]
pub struct PrototypeState {
    /// Object-tree rows: (label, depth). Selection is an index into this.
    pub objects: Vec<String>,
    pub selected_object: Option<usize>,
    pub slider_value: f64,
    pub inspector_visible: bool,
}

/// Layout constants mirror the shell grid (FVS-style: top bar + left tree +
/// inspector + chart strip).
struct PrototypeLayout {
    width: f64,
    height: f64,
    top_bar: f64,
    tree_width: f64,
    inspector_width: f64,
    chart_height: f64,
}

impl PrototypeLayout {
    fn tree_area(&self) -> [f64; 4] {
        [
            0.0,
            self.top_bar,
            self.tree_width,
            self.height - self.top_bar - self.chart_height,
        ]
    }

    fn inspector_area(&self) -> [f64; 4] {
        [
            self.width - self.inspector_width,
            self.top_bar,
            self.inspector_width,
            self.height - self.top_bar - self.chart_height,
        ]
    }

    fn chart_area(&self) -> [f64; 4] {
        [
            self.tree_width,
            self.height - self.chart_height,
            self.width - self.tree_width - self.inspector_width,
            self.chart_height,
        ]
    }
}

/// Builds the full prototype frame. Fails closed when the state cannot be
/// rendered (non-finite slider, out-of-range selection is clamped, chart
/// errors abort the frame atomically).
pub fn build_prototype_frame(
    width: f64,
    height: f64,
    state: &PrototypeState,
    palette: &ControlPalette,
) -> Result<Deep2dDisplayList, String> {
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return Err("prototype frame requires a finite positive canvas".into());
    }
    if !state.slider_value.is_finite() {
        return Err("prototype frame requires a finite slider value".into());
    }
    // Panels shrink proportionally on narrow canvases so the chart strip
    // always keeps a usable plot area (mirrors FVS grid behavior).
    let tree_width = (width * 0.24).clamp(110.0, 280.0).min(width * 0.35);
    let inspector_width = (width * 0.22).clamp(100.0, 260.0).min(width * 0.3);
    let chart_height = (height * 0.28).clamp(110.0, 240.0).min(height * 0.4);
    if width - tree_width - inspector_width < 90.0 || height - chart_height < 80.0 {
        return Err("prototype frame is too small for the shell grid".into());
    }
    let layout = PrototypeLayout {
        width,
        height,
        top_bar: 40.0,
        tree_width,
        inspector_width,
        chart_height,
    };
    let mut canvas = ControlCanvas::new();

    // Top bar strip.
    canvas.fill_rect(
        "topbar",
        [0.0, 0.0, width, layout.top_bar],
        palette.surface,
        0.0,
        1.0,
    );

    // Object tree panel + rows; the selected row gets an accent wash.
    let tree = layout.tree_area();
    canvas.fill_rect("tree-panel", tree, palette.surface_alt, 0.0, 1.0);
    let row_height = 22.0;
    for (index, label) in state.objects.iter().enumerate() {
        let row_y = tree[1] + 8.0 + index as f64 * row_height;
        if row_y + row_height > tree[1] + tree[3] {
            break; // Virtualization seam: only visible rows paint.
        }
        let is_selected = state.selected_object == Some(index);
        let label_len = label.chars().count();
        if is_selected {
            canvas.fill_rect(
                &format!("tree-row:{index}:selected"),
                [tree[0] + 4.0, row_y, tree[2] - 8.0, row_height - 2.0],
                palette.accent,
                3.0,
                0.35,
            );
        }
        canvas.stroke_polyline(
            &format!("tree-row:{index}:label"),
            &[
                [tree[0] + 10.0, row_y + row_height * 0.5],
                [
                    tree[0] + 10.0 + (label_len as f64 * 4.0).min(tree[2] - 24.0),
                    row_y + row_height * 0.5,
                ],
            ],
            palette.line,
            2.0,
            1.0,
        );
    }

    // Inspector: controls bound to the state.
    if state.inspector_visible {
        let inspector = layout.inspector_area();
        canvas.fill_rect("inspector", inspector, palette.surface_alt, 0.0, 1.0);
        let control_x = inspector[0] + 12.0;
        let control_w = inspector[2] - 24.0;
        let ctx = PaintContext {
            palette,
            disabled: false,
            focused: false,
        };
        render_slider(
            &mut canvas,
            &crate::native_ui::control_render::SliderPaint {
                id: "inspector:slider",
                rect: [control_x, inspector[1] + 16.0, control_w, 24.0],
                min: 0.0,
                max: 100.0,
                value: state.slider_value,
                ctx,
            },
        );
        render_checkbox(
            &mut canvas,
            "inspector:visible",
            [control_x, inspector[1] + 52.0, 20.0, 20.0],
            true,
            &ctx,
        );
        render_button(
            &mut canvas,
            "inspector:apply",
            [control_x, inspector[1] + 84.0, 72.0, 28.0],
            false,
            &ctx,
        );
    }

    // Chart strip: render_chart output spliced in with z bump so it stacks
    // above the strip background. Chart commands keep their own ids — the
    // splice rewrites z_order only, never geometry.
    let chart = layout.chart_area();
    canvas.fill_rect("chart-strip", chart, palette.surface, 0.0, 1.0);
    let chart_ir = demo_chart_ir(&state.objects);
    let chart_list = render_chart(&chart_ir, chart[2], chart[3])?;
    splice_chart(&mut canvas, chart_list, chart[0], chart[1]);

    Ok(canvas.into_display_list(width, height))
}

fn demo_chart_ir(objects: &[String]) -> ChartIR {
    let point_count = objects.len().clamp(4, 32);
    ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "prototype-trend".into(),
        datasets: vec![crate::chart::ChartDataset {
            id: "trend".into(),
            dimensions: vec!["x".into(), "y".into()],
            rows: (0..point_count)
                .map(|i| {
                    vec![
                        serde_json::json!(i as f64),
                        serde_json::json!((i as f64 * 7.0) % 10.0 + 1.0),
                    ]
                })
                .collect(),
        }],
        axes: vec![
            crate::chart::ChartAxis {
                id: "x".into(),
                channel: crate::chart::ChartAxisChannel::X,
                scale: crate::chart::ChartScale::Linear,
                min: None,
                max: None,
            },
            crate::chart::ChartAxis {
                id: "y".into(),
                channel: crate::chart::ChartAxisChannel::Y,
                scale: crate::chart::ChartScale::Linear,
                min: None,
                max: None,
            },
        ],
        series: vec![crate::chart::ChartSeries {
            id: "trend-line".into(),
            label: "trend".into(),
            series_type: crate::chart::ChartSeriesType::Line,
            dataset_id: "trend".into(),
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
    }
}

/// Splices a rendered chart into the frame canvas, offsetting its geometry
/// into the strip and bumping z so it stacks above the strip fill.
fn splice_chart(
    canvas: &mut ControlCanvas,
    chart: Deep2dDisplayList,
    offset_x: f64,
    offset_y: f64,
) {
    let id_prefix = "chart";
    let mut id_map = std::collections::HashMap::new();
    for (index, resource) in chart.resources.iter().enumerate() {
        if let crate::deep2d::Deep2dResource::Path(path) = resource {
            let new_id = format!("{id_prefix}:res:{index}");
            id_map.insert(path.id.clone(), new_id.clone());
            let mut moved = path.clone();
            moved.id = new_id;
            for verb in &mut moved.verbs {
                if let crate::deep2d::Deep2dPathVerb::Move { x, y }
                | crate::deep2d::Deep2dPathVerb::Line { x, y } = verb
                {
                    *x += offset_x;
                    *y += offset_y;
                }
            }
            canvas.push_resource(moved);
        }
    }
    for command in chart.commands {
        if let Deep2dCommand::Path(mut path) = command {
            path.id = format!("{id_prefix}:{}", path.id);
            if let Some(remapped) = id_map.get(&path.path_id) {
                path.path_id = remapped.clone();
            }
            path.z_order = 2;
            canvas.push_command(Deep2dCommand::Path(path));
        }
    }
}

// PathCommand/PathResource stay imported for the splice type contract.
#[allow(dead_code)]
fn type_hints(_command: PathCommand, _resource: PathResource) {}
