use std::collections::HashMap;

use super::{
    PathCommand, PathResource,
    paint_registry::PaintRegistry,
    painter::{Deep2dPainterIssue, Deep2dPainterIssueCode, PreparedDeep2d, issue},
    painter_clip::{ClipSets, clip_vertices, prepare_clip_sets},
    painter_dash::dash_subpaths,
    painter_geometry::{
        append_closed_subpath, append_stroke, bridged_ring, fill_aa_scale, stroke_tolerance,
    },
    painter_path::LinearPath,
    painter_quad,
};

#[allow(clippy::too_many_arguments)] // Mirrors the flat command surface.
pub(super) fn prepare_path(
    command: &PathCommand,
    resource: &PathResource,
    resource_path: &str,
    path: &str,
    scale_factor: f64,
    paths: &HashMap<&str, (usize, &PathResource)>,
    registry: &mut PaintRegistry,
    output: &mut PreparedDeep2d,
) -> Result<(), Deep2dPainterIssue> {
    if command.dash.is_some() && command.stroke.is_none() {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedDash,
            &format!("{path}.dash"),
            "Dash styling requires stroke paint.",
        ));
    }
    if command.dash.is_some() && command.corner_radius.is_some() {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedStyle,
            &format!("{path}.dash"),
            "Dash styling cannot combine with the analytic rounded-rect quad.",
        ));
    }
    let linear = LinearPath::from_resource(
        resource,
        resource_path,
        path,
        command.transform,
        scale_factor,
    )?;
    output.summary.path_segments += linear.segment_count();
    let opacity = command.opacity.unwrap_or(1.0) as f32;
    let clip_sets = prepare_clip_sets(
        command.clip_path_ids.as_deref(),
        paths,
        command.transform,
        scale_factor,
        path,
    )?;
    // GPUI rounded-rect quads: analytic SDF fill/stroke/shadow in the
    // fragment stage, zero CPU arc geometry.
    if command.corner_radius.is_some() {
        return prepare_quaded(
            command,
            &linear,
            opacity,
            &clip_sets,
            scale_factor,
            registry,
            output,
            path,
        );
    }
    if let Some(paint) = &command.fill {
        // Solid fills keep the v1 fast path: paint slot 0 renders from the
        // vertex color, no storage entry, byte-identical geometry pipeline.
        let (slot, vertex_color) = match paint {
            crate::deep2d::Deep2dPaint::Solid(color) => (0, *color),
            gradient => {
                let (slot, entry) = painter_quad::register_gradient(
                    registry,
                    gradient,
                    fill_aa_scale(command, scale_factor),
                    opacity,
                    path,
                )?;
                (slot, entry.color.map(f64::from))
            }
        };
        let vertices = match command.fill_rule {
            None => {
                let mut vertices = Vec::new();
                for (index, subpath) in linear.subpaths.iter().enumerate() {
                    let subpath_path = format!("{path}.subpaths[{index}]");
                    append_closed_subpath(
                        &mut vertices,
                        subpath,
                        command.transform,
                        vertex_color,
                        opacity,
                        slot,
                        &subpath_path,
                    )?;
                }
                vertices
            }
            Some(_) => {
                let ring = bridged_ring(&linear, path)?;
                let mut vertices = Vec::new();
                super::painter_geometry::append_polygon(
                    &mut vertices,
                    &ring,
                    command.transform,
                    vertex_color,
                    opacity,
                    slot,
                    path,
                )?;
                vertices
            }
        };
        let vertices = clip_vertices(&vertices, &clip_sets, path)?;
        output.summary.fill_triangles += vertices.len() / 3;
        output.vertices.extend(vertices);
    }
    if let Some(color) = command.stroke {
        let dashed_storage;
        let stroked = match command.dash.as_deref() {
            Some(pattern) => {
                dashed_storage =
                    dash_subpaths(&linear, pattern, command.dash_offset.unwrap_or(0.0), path)?;
                &dashed_storage
            }
            None => &linear,
        };
        // Round cap/join fans flatten to the same physical-pixel tolerance as
        // curves: logical tolerance divided by the command's scale magnitude.
        let stroke_tolerance = stroke_tolerance(command, scale_factor);
        let mut vertices = Vec::new();
        append_stroke(
            &mut vertices,
            stroked,
            command,
            color,
            opacity,
            stroke_tolerance,
            path,
        )?;
        let vertices = clip_vertices(&vertices, &clip_sets, path)?;
        output.summary.stroke_triangles += vertices.len() / 3;
        output.vertices.extend(vertices);
    }
    Ok(())
}

/// Rounded-rect quad: validates the rect shape and emits the six SDF vertices.
#[allow(clippy::too_many_arguments)]
fn prepare_quaded(
    command: &PathCommand,
    linear: &LinearPath,
    _opacity: f32,
    clip_sets: &ClipSets,
    scale_factor: f64,
    registry: &mut PaintRegistry,
    output: &mut PreparedDeep2d,
    path: &str,
) -> Result<(), Deep2dPainterIssue> {
    if linear.subpaths.len() != 1 {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            path,
            "Rounded rectangles require exactly one subpath.",
        ));
    }
    let subpath = &linear.subpaths[0];
    let [min, max] = painter_quad::rect_of_flatten(&subpath.points, subpath.closed, path)?;
    let first_vertex = output.vertices.len() as u32;
    painter_quad::append_quad(
        output,
        registry,
        command,
        min,
        [max[0] - min[0], max[1] - min[1]],
        command.transform,
        fill_aa_scale(command, scale_factor),
        path,
    )?;
    let vertices = clip_vertices(&output.vertices[first_vertex as usize..], clip_sets, path)?;
    let clipped = vertices.len();
    output.vertices.truncate(first_vertex as usize);
    output.vertices.extend(vertices);
    output.summary.fill_triangles += clipped / 3;
    Ok(())
}
