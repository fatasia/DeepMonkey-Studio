//! Hit-testing index for prepared display lists (D07). Pure CPU geometry:
//! commands are tested in reverse z-order (topmost first); each command
//! carries its transformed bounds, clip rectangles and stroke rings so a
//! point-in-command test matches what the painter actually draws.

use std::collections::HashMap;

use super::{
    Deep2dCommand, Deep2dDisplayList, Deep2dMatrix, Deep2dPainterIssue, Deep2dPainterIssueCode,
    painter::issue,
    painter_math::{Point, transform_point},
    painter_path::LinearPath,
};

/// One hit-testable entry, resolved from a command in draw order.
#[derive(Debug, Clone, PartialEq)]
pub struct Deep2dHitEntry {
    /// Command id (not hitId): hitId is resolved by the caller's map.
    pub id: String,
    pub z_order: i32,
    pub source_index: usize,
    pub kind: Deep2dHitKind,
    /// World-space clip rings from `clipPathIds` (command transform applied,
    /// same semantics as the painter's `prepare_clip_sets`); a point only
    /// hits when it is inside every ring.
    pub clip_rings: Vec<Vec<Point>>,
    /// Logical-space scissor rectangle; a point only hits when inside.
    pub clip_rect: Option<super::Deep2dRect>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Deep2dHitKind {
    /// Filled polygons (one ring per closed subpath), already transformed.
    Fill { rings: Vec<Vec<Point>> },
    /// Stroke polylines in world space; a point hits when its distance to
    /// any segment is at most the half stroke width (matches the painted
    /// band without re-running the stroke tessellation).
    Stroke {
        polylines: Vec<Vec<Point>>,
        half_width: f64,
    },
    /// Axis-aligned destination quad in logical space (text glyph run or
    /// image), transform applied per test point.
    Quad {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        transform: Deep2dMatrix,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Deep2dHitIndex {
    entries: Vec<Deep2dHitEntry>,
}

pub type HitResult = Result<Deep2dHitIndex, Deep2dPainterIssue>;
type ClipRingsResult = Result<Vec<Vec<Point>>, Deep2dPainterIssue>;

/// Builds the hit index from a display list. Path geometry flattens through
/// the same `LinearPath` pipeline the painter uses, so hit shapes match draw
/// shapes by construction.
pub fn build_hit_index(display_list: &Deep2dDisplayList) -> HitResult {
    let paths = display_list
        .resources
        .iter()
        .enumerate()
        .filter_map(|(index, resource)| match resource {
            super::Deep2dResource::Path(path) => Some((path.id.as_str(), (index, path))),
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    let mut ordered = display_list.commands.iter().enumerate().collect::<Vec<_>>();
    ordered.sort_by_key(|(index, command)| (hit_z_order(command), *index));

    let mut entries = Vec::new();
    for (index, command) in ordered {
        let path = format!("commands[{index}]");
        // Clip context is command-wide (fill, stroke, text and image share
        // it), resolved exactly like the painter: each clip resource must be
        // one closed simple subpath in the command's transform space.
        let (transform, clip_path_ids, clip_rect) = command_clip_context(command);
        let clip_rings = build_clip_rings(
            clip_path_ids,
            &paths,
            transform,
            &path,
            display_list.scale_factor,
        )?;
        match command {
            Deep2dCommand::Path(command) => {
                let Some((_, resource)) = paths.get(command.path_id.as_str()).copied() else {
                    // Validation guarantees existence; defensive fail-closed.
                    return Err(issue(
                        Deep2dPainterIssueCode::InvalidDisplayList,
                        &format!("{path}.pathId"),
                        "Hit index requires the path resource to exist.",
                    ));
                };
                let linear = LinearPath::from_resource(
                    resource,
                    &format!("resources[{}] (hit)", index),
                    &path,
                    command.transform,
                    display_list.scale_factor,
                )?;
                let has_fill = command.fill.is_some();
                let stroke_width = command
                    .stroke
                    .is_some()
                    .then(|| command.stroke_width.unwrap_or(1.0).max(f64::MIN_POSITIVE));
                let mut rings = Vec::new();
                let mut polylines = Vec::new();
                for subpath in &linear.subpaths {
                    let points = subpath
                        .points
                        .iter()
                        .map(|point| transform_point(*point, command.transform))
                        .collect::<Vec<_>>();
                    if subpath.closed && points.len() >= 3 {
                        rings.push(points);
                    } else if points.len() >= 2 {
                        polylines.push(points);
                    }
                }
                if has_fill && !rings.is_empty() {
                    entries.push(Deep2dHitEntry {
                        id: command.id.clone(),
                        z_order: command.z_order,
                        source_index: index,
                        kind: Deep2dHitKind::Fill { rings },
                        clip_rings: clip_rings.clone(),
                        clip_rect,
                    });
                }
                if let Some(half_width) = stroke_width.map(|width| width * 0.5) {
                    entries.push(Deep2dHitEntry {
                        id: command.id.clone(),
                        z_order: command.z_order,
                        source_index: index,
                        kind: Deep2dHitKind::Stroke {
                            polylines,
                            half_width,
                        },
                        clip_rings: clip_rings.clone(),
                        clip_rect,
                    });
                }
            }
            Deep2dCommand::Text(command) => {
                entries.push(Deep2dHitEntry {
                    id: command.id.clone(),
                    z_order: command.z_order,
                    source_index: index,
                    kind: Deep2dHitKind::Quad {
                        x: command.x,
                        y: command.y,
                        width: 0.0,
                        height: command.font_size,
                        transform: command.transform,
                    },
                    clip_rings: clip_rings.clone(),
                    clip_rect,
                });
            }
            Deep2dCommand::Image(command) => {
                entries.push(Deep2dHitEntry {
                    id: command.id.clone(),
                    z_order: command.z_order,
                    source_index: index,
                    kind: Deep2dHitKind::Quad {
                        x: command.x,
                        y: command.y,
                        width: command.width,
                        height: command.height,
                        transform: command.transform,
                    },
                    clip_rings: clip_rings.clone(),
                    clip_rect,
                });
            }
        }
    }
    Ok(Deep2dHitIndex { entries })
}

/// Flat command fields shared by every kind: transform, clip ids, clip rect.
fn command_clip_context(
    command: &Deep2dCommand,
) -> (Deep2dMatrix, Option<&[String]>, Option<super::Deep2dRect>) {
    match command {
        Deep2dCommand::Path(value) => (
            value.transform,
            value.clip_path_ids.as_deref(),
            value.clip_rect,
        ),
        Deep2dCommand::Text(value) => (
            value.transform,
            value.clip_path_ids.as_deref(),
            value.clip_rect,
        ),
        Deep2dCommand::Image(value) => (
            value.transform,
            value.clip_path_ids.as_deref(),
            value.clip_rect,
        ),
    }
}

/// Resolves clipPathIds into world-space rings with the painter's exact
/// semantics (one closed simple subpath per clip, command transform applied).
/// Any other shape fails closed — the painter would reject the command too.
fn build_clip_rings(
    ids: Option<&[String]>,
    paths: &HashMap<&str, (usize, &super::PathResource)>,
    transform: Deep2dMatrix,
    command_path: &str,
    scale_factor: f64,
) -> ClipRingsResult {
    let Some(ids) = ids.filter(|ids| !ids.is_empty()) else {
        return Ok(Vec::new());
    };
    let mut rings = Vec::with_capacity(ids.len());
    for (clip_index, id) in ids.iter().enumerate() {
        let clip_path = format!("{command_path}.clipPathIds[{clip_index}]");
        let Some((resource_index, resource)) = paths.get(id.as_str()).copied() else {
            return Err(issue(
                Deep2dPainterIssueCode::InvalidDisplayList,
                &clip_path,
                "Hit index requires the clip path resource to exist.",
            ));
        };
        let linear = LinearPath::from_resource(
            resource,
            &format!("resources[{resource_index}] (hit clip)"),
            &clip_path,
            transform,
            scale_factor,
        )?;
        if linear.subpaths.len() != 1 || !linear.subpaths[0].closed {
            return Err(issue(
                Deep2dPainterIssueCode::UnsupportedClip,
                &clip_path,
                "Each clip path must be one explicitly closed simple subpath.",
            ));
        }
        rings.push(
            linear.subpaths[0]
                .points
                .iter()
                .map(|point| transform_point(*point, transform))
                .collect(),
        );
    }
    Ok(rings)
}

fn hit_z_order(command: &Deep2dCommand) -> i32 {
    match command {
        Deep2dCommand::Path(value) => value.z_order,
        Deep2dCommand::Text(value) => value.z_order,
        Deep2dCommand::Image(value) => value.z_order,
    }
}

impl Deep2dHitIndex {
    /// Topmost entry whose geometry covers the logical point, or `None`.
    /// Later entries (drawn on top) win; entries are already z-sorted. A
    /// point only hits when it also passes the entry's clip context.
    pub fn hit(&self, point: Point) -> Option<&Deep2dHitEntry> {
        self.entries
            .iter()
            .rev()
            .find(|entry| entry.point_in_clips(point) && entry.kind_covers(point))
    }

    pub fn entries(&self) -> &[Deep2dHitEntry] {
        &self.entries
    }
}

impl Deep2dHitEntry {
    /// A point is hit-eligible only when inside every clip ring and the
    /// scissor rect — mirrors what the painter can actually paint.
    pub fn point_in_clips(&self, point: Point) -> bool {
        self.clip_rings
            .iter()
            .all(|ring| point_in_ring(point, ring))
            && self.clip_rect.is_none_or(|rect| {
                point[0] >= rect.x
                    && point[0] <= rect.x + rect.width
                    && point[1] >= rect.y
                    && point[1] <= rect.y + rect.height
            })
    }

    fn kind_covers(&self, point: Point) -> bool {
        match &self.kind {
            Deep2dHitKind::Fill { rings } => rings.iter().any(|ring| point_in_ring(point, ring)),
            Deep2dHitKind::Stroke {
                polylines,
                half_width,
            } => polylines
                .iter()
                .any(|polyline| point_near_polyline(point, polyline, *half_width)),
            Deep2dHitKind::Quad {
                x,
                y,
                width,
                height,
                transform,
            } => {
                let local = inverse_transform_point(point, *transform);
                local[0] >= *x && local[0] <= x + width && local[1] >= *y && local[1] <= y + height
            }
        }
    }
}

/// Even-odd ray cast on a ring; boundary points count as inside so draws and
/// hits agree at edges.
fn point_in_ring(point: Point, ring: &[Point]) -> bool {
    let mut inside = false;
    let mut previous = ring[ring.len() - 1];
    for current in ring {
        let crosses = (current[1] > point[1]) != (previous[1] > point[1]);
        if crosses {
            let x_at_y = (previous[0] - current[0]) * (point[1] - current[1])
                / (previous[1] - current[1])
                + current[0];
            if point[0] < x_at_y {
                inside = !inside;
            }
        }
        previous = *current;
    }
    inside
}

/// True when the point lies within `half_width` of any polyline segment —
/// the same band the stroke painter fills.
fn point_near_polyline(point: Point, polyline: &[Point], half_width: f64) -> bool {
    polyline
        .windows(2)
        .any(|pair| point_segment_distance(point, pair[0], pair[1]) <= half_width)
}

fn point_segment_distance(point: Point, start: Point, end: Point) -> f64 {
    let delta = [end[0] - start[0], end[1] - start[1]];
    let length_squared = delta[0] * delta[0] + delta[1] * delta[1];
    if length_squared <= f64::EPSILON {
        return (point[0] - start[0]).hypot(point[1] - start[1]);
    }
    let t = (((point[0] - start[0]) * delta[0] + (point[1] - start[1]) * delta[1])
        / length_squared)
        .clamp(0.0, 1.0);
    let projected = [start[0] + delta[0] * t, start[1] + delta[1] * t];
    (point[0] - projected[0]).hypot(point[1] - projected[1])
}

/// Inverse of the affine 2x3 transform, assuming an invertible linear part.
/// Mirrors how Quad destinations are authored in local space.
fn inverse_transform_point(point: Point, matrix: Deep2dMatrix) -> Point {
    let determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if determinant.abs() <= f64::EPSILON {
        return point;
    }
    let dx = point[0] - matrix[4];
    let dy = point[1] - matrix[5];
    [
        (matrix[3] * dx - matrix[2] * dy) / determinant,
        (matrix[0] * dy - matrix[1] * dx) / determinant,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deep2d::{
        Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, ImageColorSpace,
        ImageCommand, ImageResource, PathCommand, PathResource,
    };

    fn square_path() -> PathResource {
        PathResource {
            id: "hit:square".into(),
            revision: 1,
            verbs: vec![
                Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
                Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
                Deep2dPathVerb::Line { x: 10.0, y: 10.0 },
                Deep2dPathVerb::Line { x: 0.0, y: 10.0 },
                Deep2dPathVerb::Close,
            ],
        }
    }

    fn line_path() -> PathResource {
        PathResource {
            id: "hit:line".into(),
            revision: 1,
            verbs: vec![
                Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
                Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
            ],
        }
    }

    fn display_list() -> Deep2dDisplayList {
        Deep2dDisplayList {
            schema_version: 1,
            id: "hit-index-test".into(),
            revision: 1,
            logical_width: 20.0,
            logical_height: 20.0,
            scale_factor: 1.0,
            resources: vec![
                Deep2dResource::Path(square_path()),
                Deep2dResource::Path(line_path()),
                Deep2dResource::Image(ImageResource {
                    id: "img".into(),
                    revision: 1,
                    asset_id: "asset:img".into(),
                    width: 2,
                    height: 2,
                    color_space: ImageColorSpace::Srgb,
                }),
            ],
            commands: vec![
                Deep2dCommand::Path(PathCommand {
                    id: "square".into(),
                    z_order: 0,
                    transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                    opacity: None,
                    clip_path_ids: None,
                    clip_rect: None,
                    hit_id: Some("square-hit".into()),
                    path_id: "hit:square".into(),
                    fill: Some([1.0, 1.0, 1.0, 1.0]),
                    fill_rule: None,
                    stroke: None,
                    stroke_width: None,
                    line_cap: None,
                    line_join: None,
                    miter_limit: None,
                    dash: None,
                    dash_offset: None,
                }),
                Deep2dCommand::Image(ImageCommand {
                    id: "image".into(),
                    z_order: 1,
                    transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                    opacity: None,
                    clip_path_ids: None,
                    clip_rect: None,
                    hit_id: None,
                    image_id: "img".into(),
                    x: 7.0,
                    y: 7.0,
                    width: 2.0,
                    height: 2.0,
                    atlas_id: None,
                    source: None,
                    sampling: None,
                }),
                Deep2dCommand::Path(PathCommand {
                    id: "line".into(),
                    z_order: 2,
                    transform: [1.0, 0.0, 0.0, 1.0, 5.0, 5.0],
                    opacity: None,
                    clip_path_ids: None,
                    clip_rect: None,
                    hit_id: None,
                    path_id: "hit:line".into(),
                    fill: None,
                    fill_rule: None,
                    stroke: Some([0.0, 0.0, 0.0, 1.0]),
                    stroke_width: Some(2.0),
                    line_cap: None,
                    line_join: None,
                    miter_limit: None,
                    dash: None,
                    dash_offset: None,
                }),
            ],
            atlases: Vec::new(),
        }
    }

    #[test]
    fn topmost_z_order_wins_over_covered_underlays() {
        let index = build_hit_index(&display_list()).expect("index builds");
        // The image (z=1) spans [7,9]² clear of the stroke band y∈[4,6].
        let hit = index.hit([8.0, 8.0]).expect("image hit");
        assert_eq!(hit.id, "image");
        // Inside the stroke band the topmost line (z=2) wins instead.
        let hit = index.hit([5.5, 5.5]).expect("inside the stroke band");
        assert_eq!(hit.id, "line", "topmost stroke wins inside its band");
        // Outside the image but inside the square hits the square.
        let hit = index.hit([3.0, 8.0]).expect("square hit");
        assert_eq!(hit.id, "square");
        // Far outside hits nothing.
        assert!(index.hit([19.0, 19.0]).is_none());
    }

    #[test]
    fn stroke_entries_hit_inside_their_band() {
        let index = build_hit_index(&display_list()).expect("index builds");
        // The line (z=2) strokes from (5,5) to (15,5) with width 2 — the
        // stroke band covers y∈[4,6]; its topmost status must win over the
        // image below at the same point.
        let hit = index.hit([10.0, 5.0]).expect("stroke hit");
        assert_eq!(hit.id, "line");
        // Just outside the band the square takes over.
        let hit = index
            .hit([5.5, 6.2])
            .expect("square outside the stroke band");
        assert_eq!(hit.id, "square");
        // A miss far from every band falls through to the square.
        let hit = index.hit([5.0, 9.0]).expect("square far from the stroke");
        assert_eq!(hit.id, "square");
    }

    #[test]
    fn transformed_quads_hit_in_local_space() {
        let mut list = display_list();
        let Deep2dCommand::Image(command) = &mut list.commands[1] else {
            panic!("image command")
        };
        // Rotate 90°: matrix [0,1,-1,0,10,0] maps local (x,y) to world
        // (10-y, x). The quad at local [7,9]² lands at world x∈[1,3],
        // y∈[7,9] — clear of both the square interior and the stroke band.
        command.transform = [0.0, 1.0, -1.0, 0.0, 10.0, 0.0];
        let index = build_hit_index(&list).expect("index builds");
        // World (2,8) maps back to local (10-8, 2) = (2,8): outside the
        // original local quad [7,9]² but inside the rotated world box
        // [1,3]×[7,9] — the transformed image wins over the square.
        let hit = index
            .hit([2.0, 8.0])
            .expect("rotated image wins over the square");
        assert_eq!(hit.id, "image");
        // World (5,8) sits inside the square but outside the rotated box.
        let hit = index
            .hit([5.0, 8.0])
            .expect("square beside the rotated quad");
        assert_eq!(hit.id, "square");
        // The quad's own world box: local [7,9]² -> world [10-9,10-7]x[7,9] = [1,3]x[7,9].
        let mut list2 = display_list();
        let Deep2dCommand::Image(command) = &mut list2.commands[1] else {
            panic!("image command")
        };
        command.transform = [0.0, 1.0, -1.0, 0.0, 10.0, 0.0];
        command.x = 1.0;
        command.y = 7.0;
        let index2 = build_hit_index(&list2).expect("index builds");
        // local [1,3]x[7,9] -> world [10-9,10-7]x[1,3] = [1,3]x[1,3].
        let hit = index2.hit([2.0, 2.0]).expect("rotated quad hit");
        assert_eq!(hit.id, "image");
    }
}
