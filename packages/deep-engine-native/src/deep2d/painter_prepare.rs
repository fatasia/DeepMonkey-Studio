use std::collections::HashMap;

use super::{
    PathCommand, PathResource,
    painter::{Deep2dPainterIssue, Deep2dPainterIssueCode, PreparedDeep2d, issue},
    painter_clip::{clip_vertices, prepare_clip_sets},
    painter_dash::dash_subpaths,
    painter_geometry::{append_fill, append_stroke},
    painter_path::{DEEP2D_CURVE_TOLERANCE, LinearPath},
};

pub(super) fn prepare_path(
    command: &PathCommand,
    resource: &PathResource,
    resource_path: &str,
    path: &str,
    scale_factor: f64,
    paths: &HashMap<&str, (usize, &PathResource)>,
    output: &mut PreparedDeep2d,
) -> Result<(), Deep2dPainterIssue> {
    if command.dash.is_some() && command.stroke.is_none() {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedDash,
            &format!("{path}.dash"),
            "Dash styling requires stroke paint.",
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
    if let Some(color) = command.fill {
        let mut vertices = Vec::new();
        append_fill(
            &mut vertices,
            &linear,
            command.fill_rule,
            command.transform,
            color,
            opacity,
            path,
        )?;
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

/// Physical-pixel flattening tolerance mapped back to logical units for the
/// command's transform; matches the curve flattening tolerance contract.
fn stroke_tolerance(command: &PathCommand, scale_factor: f64) -> f64 {
    let scale_bound = (command.transform[0] * command.transform[0]
        + command.transform[1] * command.transform[1]
        + command.transform[2] * command.transform[2]
        + command.transform[3] * command.transform[3])
        .sqrt();
    let physical = (scale_bound * scale_factor).max(1e-12);
    (DEEP2D_CURVE_TOLERANCE / physical).max(1e-12)
}
