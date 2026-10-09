//! GPUI-style rounded-rect quads: `PathCommand::cornerRadius` + `shadow`
//! rasterize through the fragment-stage rounded-box SDF with zero CPU arc
//! geometry. The command's path resource must be one closed axis-aligned
//! rectangle (validated here, fail-closed); its AABB defines the quad in the
//! command's local space. Six vertices span the quad inflated by the shadow
//! reach and the stroke half width; all shading happens per fragment in
//! `paint_data::quad_fragment`.

use super::{
    BoxShadow, PathCommand,
    paint_data::{
        DEEP2D_MAX_GRADIENT_STOPS, DEEP2D_PAINT_KIND_QUAD, Deep2dPaintData, Deep2dPaintStop,
        clamp_corner_radius,
    },
    paint_registry::PaintRegistry,
    painter::{Deep2dPainterIssue, Deep2dPainterIssueCode, PreparedDeep2d, issue},
    painter_math::{Point, transform_point},
};

/// One closed, axis-aligned rectangle from the flattened path. Exactly two
/// distinct x and two distinct y values, and every point sits on the grid —
/// that is precisely a four-corner rectangle.
pub(super) fn rect_of_flatten(
    points: &[Point],
    closed: bool,
    command_path: &str,
) -> Result<[Point; 2], Deep2dPainterIssue> {
    const EPSILON: f64 = 1e-9;
    if !closed || points.len() != 4 {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            command_path,
            "Rounded rectangles require a path with exactly one closed four-point rectangle.",
        ));
    }
    let xs = [points[0][0], points[1][0], points[2][0], points[3][0]];
    let ys = [points[0][1], points[1][1], points[2][1], points[3][1]];
    let distinct_x = distinct_values(&xs, EPSILON);
    let distinct_y = distinct_values(&ys, EPSILON);
    let on_grid = distinct_x.len() == 2
        && distinct_y.len() == 2
        && xs.iter().zip(ys.iter()).all(|(x, y)| {
            distinct_x.iter().any(|value| (value - x).abs() <= EPSILON)
                && distinct_y.iter().any(|value| (value - y).abs() <= EPSILON)
        });
    if !on_grid {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            command_path,
            "Rounded rectangles require an axis-aligned rectangle path.",
        ));
    }
    Ok([
        [distinct_x[0], distinct_y[0]],
        [distinct_x[1], distinct_y[1]],
    ])
}

fn distinct_values(values: &[f64; 4], epsilon: f64) -> Vec<f64> {
    let mut distinct: Vec<f64> = Vec::with_capacity(2);
    for value in values {
        if !distinct
            .iter()
            .any(|existing| (existing - value).abs() <= epsilon)
        {
            distinct.push(*value);
            if distinct.len() > 2 {
                break;
            }
        }
    }
    distinct
}

/// GPUI quad semantics on a PathCommand: fills/strokes/shadows the rect
/// through the analytic SDF and emits the six vertices into the shared path
/// vertex stream. Returns the storage slot(s) appended to `paints`.
#[allow(clippy::too_many_arguments)] // Quad field surface mirrors PathCommand.
pub(super) fn append_quad(
    output: &mut PreparedDeep2d,
    registry: &mut PaintRegistry,
    command: &PathCommand,
    origin: Point,
    size: [f64; 2],
    transform: [f64; 6],
    aa_scale: f64,
    command_path: &str,
) -> Result<(), Deep2dPainterIssue> {
    let corner_radius = command.corner_radius.unwrap_or(0.0);
    let shadow = command.shadow;
    let fill_color = command
        .fill
        .as_ref()
        .and_then(super::Deep2dPaint::solid_color);
    let stroke_color = command.stroke;
    if command.fill.is_none() && stroke_color.is_none() && shadow.is_none() {
        // 刀 4:纯 backdrop 命令(毛玻璃)没有 fill/stroke/shadow,底色由
        // backdrop 捕获链绘制;无 blur 时仍 fail-closed。
        if command.backdrop_blur.is_none() {
            return Err(issue(
                Deep2dPainterIssueCode::UnsupportedStyle,
                command_path,
                "Quad commands require fill, stroke or shadow paint.",
            ));
        }
    }
    if size[0] <= 0.0 || size[1] <= 0.0 {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            command_path,
            "Quad rect requires positive width and height.",
        ));
    }
    let fill_slot = match &command.fill {
        Some(super::Deep2dPaint::Solid(color)) => {
            // Solid fill: kept in the entry itself (fill_index 0).
            let _ = color;
            0
        }
        Some(paint) => register_gradient(registry, paint, aa_scale, 1.0, command_path)?.0,
        None => 0,
    };
    let opacity = command.opacity.unwrap_or(1.0) as f32;
    let stroke_width = if stroke_color.is_some() {
        command.stroke_width.unwrap_or(1.0) as f32
    } else {
        0.0
    };
    let half = [size[0] * 0.5, size[1] * 0.5];
    let half_f32 = [half[0] as f32, half[1] as f32];
    let radius = clamp_corner_radius(corner_radius as f32, half_f32);
    let reach = bounds_reach(command);
    let entry = Deep2dPaintData {
        kind: DEEP2D_PAINT_KIND_QUAD,
        aa_scale: aa_scale as f32,
        stop_count: 0,
        opacity,
        fill_index: fill_slot,
        stroke_width,
        radius,
        shadow_radius: shadow
            .map(|shadow| {
                clamp_corner_radius(
                    shadow.radius(corner_radius) as f32,
                    inflated_half(half_f32, &shadow),
                )
            })
            .unwrap_or(0.0),
        p0: [(origin[0] + half[0]) as f32, (origin[1] + half[1]) as f32],
        p1: half.map(|value| value as f32),
        color: fill_color
            .map(|color| color.map(|channel| channel as f32))
            .unwrap_or([0.0; 4]),
        stroke_color: stroke_color
            .map(|color| {
                [
                    color[0] as f32,
                    color[1] as f32,
                    color[2] as f32,
                    color[3] as f32,
                ]
            })
            .unwrap_or([0.0; 4]),
        shadow_offset: shadow
            .map(|shadow| [shadow.offset_x as f32, shadow.offset_y as f32])
            .unwrap_or([0.0; 2]),
        shadow_blur: shadow.map_or(0.0, |shadow| shadow.blur_radius as f32),
        shadow_spread: shadow.map_or(0.0, |shadow| shadow.spread as f32),
        shadow_color: shadow
            .map(|shadow| shadow.color.map(|channel| channel as f32))
            .unwrap_or([0.0; 4]),
        stops: [Default::default(); DEEP2D_MAX_GRADIENT_STOPS],
    };
    let quad_slot = registry.register(entry)?;
    // Expand the drawn geometry to cover shadow spread, blur reach, offsets
    // and the outer stroke half so every shaded fragment has geometry.
    let pad = [
        reach[0] + stroke_width as f64 * 0.5 + 1.0,
        reach[1] + stroke_width as f64 * 0.5 + 1.0,
    ];
    let min = [origin[0] - pad[0], origin[1] - pad[1]];
    let max = [origin[0] + size[0] + pad[0], origin[1] + size[1] + pad[1]];
    let corners = [
        [min[0], min[1]],
        [max[0], min[1]],
        [max[0], max[1]],
        [min[0], max[1]],
    ];
    for index in [0usize, 1, 2, 0, 2, 3] {
        let local = corners[index];
        let canvas = transform_point(local, transform);
        output.vertices.push([
            canvas[0] as f32,
            canvas[1] as f32,
            0.0,
            0.0,
            0.0,
            0.0,
            local[0] as f32,
            local[1] as f32,
            quad_slot as f32,
        ]);
    }
    Ok(())
}

fn inflated_half(half: [f32; 2], shadow: &BoxShadow) -> [f32; 2] {
    [
        (half[0] + shadow.spread as f32).max(0.0),
        (half[1] + shadow.spread as f32).max(0.0),
    ]
}

/// Per-axis distance the drawn geometry must extend beyond the rect so the
/// blurred shadow (offset + spread + blur falloff) fully fits.
fn bounds_reach(command: &PathCommand) -> [f64; 2] {
    let Some(shadow) = command.shadow else {
        return [0.0, 0.0];
    };
    [
        shadow.offset_x.abs() + shadow.blur_radius + shadow.spread.max(0.0),
        shadow.offset_y.abs() + shadow.blur_radius + shadow.spread.max(0.0),
    ]
}

/// Registers a linear/radial gradient paint entry for quad fills. Solid quad
/// paints stay in the quad entry; this handles the gradient arms and sorts
/// stops canonically so CPU and GPU evaluate identically.
pub(super) fn register_gradient(
    registry: &mut PaintRegistry,
    paint: &super::Deep2dPaint,
    aa_scale: f64,
    opacity: f32,
    command_path: &str,
) -> Result<(u32, Deep2dPaintData), Deep2dPainterIssue> {
    let mut stops = match paint {
        super::Deep2dPaint::LinearGradient(gradient) => {
            let mut entry = Deep2dPaintData {
                kind: super::paint_data::DEEP2D_PAINT_KIND_LINEAR,
                aa_scale: aa_scale as f32,
                p0: [gradient.start[0] as f32, gradient.start[1] as f32],
                p1: [gradient.end[0] as f32, gradient.end[1] as f32],
                ..Default::default()
            };
            copy_stops(&gradient.stops, &mut entry, command_path)?;
            entry
        }
        super::Deep2dPaint::RadialGradient(gradient) => {
            let mut entry = Deep2dPaintData {
                kind: super::paint_data::DEEP2D_PAINT_KIND_RADIAL,
                aa_scale: aa_scale as f32,
                p0: [gradient.center[0] as f32, gradient.center[1] as f32],
                radius: gradient.radius as f32,
                ..Default::default()
            };
            copy_stops(&gradient.stops, &mut entry, command_path)?;
            entry
        }
        super::Deep2dPaint::Solid(color) => Deep2dPaintData {
            kind: super::paint_data::DEEP2D_PAINT_KIND_SOLID,
            color: color.map(|channel| channel as f32),
            ..Default::default()
        },
    };
    // Path fills bake command opacity here (fragments scale the stop alpha);
    // quad fills pass 1.0 because the quad entry fades each layer itself.
    stops.opacity = if matches!(paint, super::Deep2dPaint::Solid(_)) {
        stops.opacity
    } else {
        opacity
    };
    sort_stops(&mut stops.stops, stops.stop_count as usize);
    let slot = registry.register(stops)?;
    Ok((slot, stops))
}

pub(super) fn copy_stops(
    stops: &[super::GradientStop],
    entry: &mut Deep2dPaintData,
    command_path: &str,
) -> Result<(), Deep2dPainterIssue> {
    if stops.is_empty() || stops.len() > DEEP2D_MAX_GRADIENT_STOPS {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedStyle,
            &format!("{command_path}.stops"),
            &format!("Gradients require 1..{DEEP2D_MAX_GRADIENT_STOPS} stops."),
        ));
    }
    for (index, stop) in stops.iter().enumerate() {
        entry.stops[index] = Deep2dPaintStop::new(stop.offset, stop.color);
    }
    entry.stop_count = stops.len() as u32;
    entry.color = entry.stops[0].color;
    Ok(())
}

/// Stable insertion sort by offset (validation keeps the count bounded).
pub(super) fn sort_stops(stops: &mut [Deep2dPaintStop], count: usize) {
    for index in 1..count.min(stops.len()) {
        let mut cursor = index;
        while cursor > 0 && stops[cursor].offset < stops[cursor - 1].offset {
            stops.swap(cursor, cursor - 1);
            cursor -= 1;
        }
    }
}
