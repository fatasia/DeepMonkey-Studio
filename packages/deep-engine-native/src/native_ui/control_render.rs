//! U04: control paint layer. Turns control STATE (from controls.rs) into
//! Deep2D display-list geometry, so buttons/toggles/sliders render through
//! the same painter as charts and HUD. Colors come from the design-token
//! snapshot semantics (see native_ui/design_tokens.rs); disabled/focused
//! states MUST produce visibly different geometry — asserted by tests.

use crate::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dRect, Deep2dResource, PathCommand,
    PathResource,
};

/// Theme palette resolved from the design-token snapshot (dark defaults).
/// Values mirror fixtures/design-tokens-v1.json so the paint layer never
/// invents its own colors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ControlPalette {
    pub accent: [f64; 4],
    pub surface: [f64; 4],
    pub surface_alt: [f64; 4],
    pub line: [f64; 4],
    pub focus_ring: [f64; 4],
}

impl ControlPalette {
    pub fn dark() -> Self {
        Self {
            accent: [0.8392, 0.6667, 0.302, 1.0],
            surface: [0.067, 0.098, 0.114, 1.0],
            surface_alt: [0.09, 0.129, 0.149, 1.0],
            line: [0.655, 0.718, 0.745, 0.26],
            focus_ring: [0.396, 0.682, 0.91, 1.0],
        }
    }

    pub fn light() -> Self {
        Self {
            accent: [0.8392, 0.6667, 0.302, 1.0],
            surface: [1.0, 1.0, 1.0, 1.0],
            surface_alt: [0.945, 0.961, 0.965, 1.0],
            line: [0.141, 0.216, 0.251, 0.26],
            focus_ring: [0.141, 0.412, 0.616, 1.0],
        }
    }
}

/// Accumulates path resources + commands for one control paint pass.
#[derive(Debug, Default)]
pub struct ControlCanvas {
    resources: Vec<PathResource>,
    commands: Vec<Deep2dCommand>,
}

/// Contract-level opacity for disabled controls: the whole control fades,
/// mirroring how the web shell dims disabled widgets.
pub const DISABLED_OPACITY: f64 = 0.4;
const FOCUS_RING_INSET: f64 = -3.0;
const FOCUS_RING_WIDTH: f64 = 2.0;

/// Focus-ring geometry shared by the paint layer and the keyboard a11y path
/// (P1-16): the ring floats `FOCUS_RING_INSET` outside the control rect.
/// Single source of truth so a keyboard-focused chart legend item reports
/// exactly the rect the paint layer would stroke.
pub fn focus_ring_rect(rect: [f64; 4]) -> [f64; 4] {
    [
        rect[0] + FOCUS_RING_INSET,
        rect[1] + FOCUS_RING_INSET,
        rect[2] - FOCUS_RING_INSET * 2.0,
        rect[3] - FOCUS_RING_INSET * 2.0,
    ]
}

impl ControlCanvas {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fills one rectangle (optionally rounded) with a color.
    pub fn fill_rect(
        &mut self,
        id: &str,
        rect: [f64; 4],
        color: [f64; 4],
        radius: f64,
        opacity: f64,
    ) {
        let resource_id = format!("res:{id}");
        self.resources.push(PathResource {
            id: resource_id.clone(),
            revision: 1,
            verbs: rect_verbs(rect, radius),
        });
        self.commands.push(Deep2dCommand::Path(PathCommand {
            id: id.to_string(),
            z_order: 0,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: Some(opacity),
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: resource_id,
            fill: Some(color),
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

    /// Strokes one open polyline.
    pub fn stroke_polyline(
        &mut self,
        id: &str,
        points: &[[f64; 2]],
        color: [f64; 4],
        width: f64,
        opacity: f64,
    ) {
        if points.len() < 2 {
            return;
        }
        let resource_id = format!("res:{id}");
        let mut verbs = vec![Deep2dPathVerb::Move {
            x: points[0][0],
            y: points[0][1],
        }];
        for point in &points[1..] {
            verbs.push(Deep2dPathVerb::Line {
                x: point[0],
                y: point[1],
            });
        }
        self.resources.push(PathResource {
            id: resource_id.clone(),
            revision: 1,
            verbs,
        });
        self.commands.push(Deep2dCommand::Path(PathCommand {
            id: id.to_string(),
            z_order: 1,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: Some(opacity),
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: resource_id,
            fill: None,
            fill_rule: None,
            stroke: Some(color),
            stroke_width: Some(width),
            line_cap: Some(crate::deep2d::LineCap::Round),
            line_join: Some(crate::deep2d::LineJoin::Round),
            miter_limit: None,
            dash: None,
            dash_offset: None,
        }));
    }

    /// Focus ring: stroked rectangle floating just outside the control.
    pub fn focus_ring(&mut self, id: &str, rect: [f64; 4], palette: &ControlPalette) {
        let ring = focus_ring_rect(rect);
        let points = rect_outline_points(ring);
        self.stroke_polyline(
            &format!("{id}:focus"),
            &points,
            palette.focus_ring,
            FOCUS_RING_WIDTH,
            1.0,
        );
    }

    /// Crate-internal splice access for the prototype frame builder (U09):
    /// chart/child geometry merges into the same canvas.
    pub(crate) fn push_resource(&mut self, resource: PathResource) {
        self.resources.push(resource);
    }

    pub(crate) fn push_command(&mut self, command: Deep2dCommand) {
        self.commands.push(command);
    }

    pub fn into_display_list(self, width: f64, height: f64) -> Deep2dDisplayList {
        Deep2dDisplayList {
            schema_version: 1,
            id: "controls".into(),
            revision: 1,
            logical_width: width,
            logical_height: height,
            scale_factor: 1.0,
            resources: self
                .resources
                .into_iter()
                .map(Deep2dResource::Path)
                .collect(),
            commands: self.commands,
            atlases: Vec::new(),
        }
    }
}

fn rect_verbs(rect: [f64; 4], radius: f64) -> Vec<Deep2dPathVerb> {
    if radius <= 0.0 {
        return rect_verbs_sharp(rect);
    }
    let [x, y, w, h] = rect;
    let radius = radius.min(w.min(h) * 0.5);
    let horizontal = w - radius * 2.0;
    let vertical = h - radius * 2.0;
    // Chamfered corners degenerate when the radius consumes a full edge
    // (circle-style knobs): collapse to the surviving corner points so no
    // zero-length segment ever reaches the painter.
    let epsilon = 1e-6;
    let mut points = Vec::with_capacity(8);
    if horizontal > epsilon {
        points.push([x + radius, y]);
        points.push([x + w - radius, y]);
    }
    if vertical > epsilon {
        points.push([x + w, y + radius]);
        points.push([x + w, y + h - radius]);
    }
    if horizontal > epsilon {
        points.push([x + w - radius, y + h]);
        points.push([x + radius, y + h]);
    }
    if vertical > epsilon {
        points.push([x, y + h - radius]);
        points.push([x, y + radius]);
    }
    if points.len() < 3 {
        // Fully degenerate: keep a visible diamond instead of failing.
        let cx = x + w * 0.5;
        let cy = y + h * 0.5;
        return rect_verbs_points(&[[cx, y], [x + w, cy], [cx, y + h], [x, cy]]);
    }
    rect_verbs_points(&points)
}

fn rect_verbs_sharp(rect: [f64; 4]) -> Vec<Deep2dPathVerb> {
    let [x, y, w, h] = rect;
    rect_verbs_points(&[[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
}

fn rect_verbs_points(points: &[[f64; 2]]) -> Vec<Deep2dPathVerb> {
    let mut verbs = vec![Deep2dPathVerb::Move {
        x: points[0][0],
        y: points[0][1],
    }];
    for point in &points[1..] {
        verbs.push(Deep2dPathVerb::Line {
            x: point[0],
            y: point[1],
        });
    }
    verbs.push(Deep2dPathVerb::Close);
    verbs
}

fn rect_outline_points(rect: [f64; 4]) -> Vec<[f64; 2]> {
    let [x, y, w, h] = rect;
    vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]
}

/// Shared paint context: theme + interactive state every renderer needs.
#[derive(Debug, Clone, Copy)]
pub struct PaintContext<'a> {
    pub palette: &'a ControlPalette,
    pub disabled: bool,
    pub focused: bool,
}

impl PaintContext<'_> {
    fn opacity(&self) -> f64 {
        if self.disabled { DISABLED_OPACITY } else { 1.0 }
    }

    fn paint_focus(&self) -> bool {
        self.focused && !self.disabled
    }
}

/// Button: filled rounded rect; focused draws a ring; disabled fades.
pub fn render_button(
    canvas: &mut ControlCanvas,
    id: &str,
    rect: [f64; 4],
    pressed: bool,
    ctx: &PaintContext,
) {
    let mut fill = ctx.palette.accent;
    if pressed {
        fill = [fill[0] * 0.8, fill[1] * 0.8, fill[2] * 0.8, fill[3]];
    }
    canvas.fill_rect(id, rect, fill, 6.0, ctx.opacity());
    if ctx.paint_focus() {
        canvas.focus_ring(id, rect, ctx.palette);
    }
}

/// Toggle: track + knob; knob sits right when checked.
pub fn render_toggle(
    canvas: &mut ControlCanvas,
    id: &str,
    rect: [f64; 4],
    checked: bool,
    ctx: &PaintContext,
) {
    let opacity = ctx.opacity();
    let track_color = if checked {
        ctx.palette.accent
    } else {
        ctx.palette.surface_alt
    };
    canvas.fill_rect(id, rect, track_color, rect[3] * 0.5, opacity);
    let knob_diameter = rect[3] - 4.0;
    let knob_x = if checked {
        rect[0] + rect[2] - knob_diameter - 2.0
    } else {
        rect[0] + 2.0
    };
    let knob_rect = [knob_x, rect[1] + 2.0, knob_diameter, knob_diameter];
    canvas.fill_rect(
        &format!("{id}:knob"),
        knob_rect,
        [1.0, 1.0, 1.0, 1.0],
        knob_diameter * 0.5,
        opacity,
    );
    if ctx.paint_focus() {
        canvas.focus_ring(id, rect, ctx.palette);
    }
}

/// Checkbox: square + check mark polyline when checked.
pub fn render_checkbox(
    canvas: &mut ControlCanvas,
    id: &str,
    rect: [f64; 4],
    checked: bool,
    ctx: &PaintContext,
) {
    let opacity = ctx.opacity();
    let box_color = if checked {
        ctx.palette.accent
    } else {
        ctx.palette.surface
    };
    canvas.fill_rect(id, rect, box_color, 4.0, opacity);
    if checked {
        let [x, y, w, h] = rect;
        canvas.stroke_polyline(
            &format!("{id}:check"),
            &[
                [x + w * 0.25, y + h * 0.55],
                [x + w * 0.45, y + h * 0.75],
                [x + w * 0.78, y + h * 0.28],
            ],
            [1.0, 1.0, 1.0, 1.0],
            2.0,
            opacity,
        );
    }
    if ctx.paint_focus() {
        canvas.focus_ring(id, rect, ctx.palette);
    }
}

/// Select: value box + chevron; open state appends the dropdown panel with
/// the highlighted row filled.
pub struct SelectPaint<'a> {
    pub id: &'a str,
    pub rect: [f64; 4],
    pub open: bool,
    pub highlighted_index: usize,
    pub row_height: f64,
    pub ctx: PaintContext<'a>,
}

pub fn render_select(canvas: &mut ControlCanvas, paint: &SelectPaint) {
    let SelectPaint {
        id,
        rect,
        open,
        highlighted_index,
        row_height,
        ctx,
    } = *paint;
    let palette = ctx.palette;
    let opacity = ctx.opacity();
    let disabled = ctx.disabled;
    let focused = ctx.focused;
    canvas.fill_rect(id, rect, palette.surface, 4.0, opacity);
    let [x, y, w, h] = rect;
    canvas.stroke_polyline(
        &format!("{id}:chevron"),
        &[
            [x + w - 16.0, y + h * 0.4],
            [x + w - 10.0, y + h * 0.6],
            [x + w - 4.0, y + h * 0.4],
        ],
        palette.line,
        2.0,
        opacity,
    );
    if open {
        let panel_height = row_height * 3.0;
        let panel = [x, y + h + 2.0, w, panel_height];
        canvas.fill_rect(
            &format!("{id}:panel"),
            panel,
            palette.surface_alt,
            4.0,
            opacity,
        );
        let highlight = [
            panel[0] + 2.0,
            panel[1] + row_height * highlighted_index as f64 + 2.0,
            panel[2] - 4.0,
            row_height,
        ];
        canvas.fill_rect(
            &format!("{id}:highlight"),
            highlight,
            palette.accent,
            2.0,
            0.35 * opacity,
        );
    }
    if focused && !disabled {
        canvas.focus_ring(id, rect, palette);
    }
}

/// Slider: track, filled portion, knob positioned by value.
pub struct SliderPaint<'a> {
    pub id: &'a str,
    pub rect: [f64; 4],
    pub min: f64,
    pub max: f64,
    pub value: f64,
    pub ctx: PaintContext<'a>,
}

pub fn render_slider(canvas: &mut ControlCanvas, paint: &SliderPaint) {
    let SliderPaint {
        id,
        rect,
        min,
        max,
        value,
        ctx,
    } = *paint;
    let palette = ctx.palette;
    let opacity = ctx.opacity();
    let disabled = ctx.disabled;
    let focused = ctx.focused;
    let [x, y, w, h] = rect;
    let track_y = y + h * 0.5;
    canvas.stroke_polyline(
        &format!("{id}:track"),
        &[[x, track_y], [x + w, track_y]],
        palette.line,
        4.0,
        opacity,
    );
    let fraction = if (max - min).abs() <= f64::EPSILON {
        0.0
    } else {
        ((value - min) / (max - min)).clamp(0.0, 1.0)
    };
    let knob_x = x + w * fraction;
    canvas.stroke_polyline(
        &format!("{id}:fill"),
        &[[x, track_y], [knob_x, track_y]],
        palette.accent,
        4.0,
        opacity,
    );
    let knob = 12.0;
    canvas.fill_rect(
        &format!("{id}:knob"),
        [knob_x - knob * 0.5, track_y - knob * 0.5, knob, knob],
        [1.0, 1.0, 1.0, 1.0],
        knob * 0.5,
        opacity,
    );
    if focused && !disabled {
        canvas.focus_ring(id, rect, palette);
    }
}

/// Keep the validator's rect type referenced for callers building clips.
#[allow(dead_code)]
fn rect_type_hint(rect: Deep2dRect) -> Deep2dRect {
    rect
}
