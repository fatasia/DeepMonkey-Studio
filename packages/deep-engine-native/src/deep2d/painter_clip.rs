use std::collections::HashMap;

use super::{
    Deep2dMatrix, Deep2dPainterIssue, Deep2dPainterIssueCode, PathResource,
    painter::issue,
    painter_math::{Point, transform_point},
    painter_path::LinearPath,
    painter_polygon::triangulate_simple_polygon,
};

pub(super) type ClipSets = Vec<Vec<[[f32; 2]; 3]>>;
const MAX_CLIPPED_VERTICES: usize = 2_000_000;
const MAX_CLIP_PAIR_TESTS: usize = 4_000_000;

pub(super) fn prepare_clip_sets(
    ids: Option<&[String]>,
    paths: &HashMap<&str, (usize, &PathResource)>,
    transform: Deep2dMatrix,
    scale_factor: f64,
    command_path: &str,
) -> Result<ClipSets, Deep2dPainterIssue> {
    let Some(ids) = ids.filter(|ids| !ids.is_empty()) else {
        return Ok(Vec::new());
    };
    ids.iter()
        .enumerate()
        .map(|(clip_index, id)| {
            let (resource_index, resource) = paths[id.as_str()];
            let path = format!("{command_path}.clipPathIds[{clip_index}]");
            let linear = LinearPath::from_resource(
                resource,
                &format!("resources[{resource_index}]"),
                &path,
                transform,
                scale_factor,
            )?;
            if linear.subpaths.len() != 1
                || !linear.subpaths[0].closed
                || linear.subpaths[0].points.len() < 3
            {
                return Err(issue(
                    Deep2dPainterIssueCode::UnsupportedClip,
                    &path,
                    "Each clip path must be one explicitly closed simple subpath.",
                ));
            }
            let points = linear.subpaths[0]
                .points
                .iter()
                .map(|point| transform_point(*point, transform))
                .collect::<Vec<Point>>();
            let triangles = triangulate_simple_polygon(&points, &path)?;
            Ok(triangles
                .into_iter()
                .map(|[a, b, c]| [to_f32(points[a]), to_f32(points[b]), to_f32(points[c])])
                .collect())
        })
        .collect()
}

pub(super) fn clip_vertices<const N: usize>(
    vertices: &[[f32; N]],
    clip_sets: &ClipSets,
    path: &str,
) -> Result<Vec<[f32; N]>, Deep2dPainterIssue> {
    if clip_sets.is_empty() {
        return Ok(vertices.to_vec());
    }
    let mut triangles = vertices
        .chunks_exact(3)
        .map(|items| [items[0], items[1], items[2]])
        .collect::<Vec<_>>();
    for clip_set in clip_sets {
        if triangles
            .len()
            .checked_mul(clip_set.len())
            .is_none_or(|pairs| pairs > MAX_CLIP_PAIR_TESTS)
        {
            return Err(issue(
                Deep2dPainterIssueCode::TessellationBudgetExceeded,
                path,
                "Path clipping exceeds the bounded intersection work budget.",
            ));
        }
        let mut next = Vec::new();
        for subject in triangles {
            for clip in clip_set {
                let polygon = clip_triangle(subject, *clip);
                for index in 1..polygon.len().saturating_sub(1) {
                    let triangle = [polygon[0], polygon[index], polygon[index + 1]];
                    if vertex_cross(triangle[0], triangle[1], triangle[2]).abs() > 1e-7 {
                        if (next.len() + 1) * 3 > MAX_CLIPPED_VERTICES {
                            return Err(issue(
                                Deep2dPainterIssueCode::TessellationBudgetExceeded,
                                path,
                                "Path clipping exceeds the bounded output vertex budget.",
                            ));
                        }
                        next.push(triangle);
                    }
                }
            }
        }
        triangles = next;
        if triangles.is_empty() {
            break;
        }
    }
    Ok(triangles.into_iter().flatten().collect())
}

fn clip_triangle<const N: usize>(subject: [[f32; N]; 3], clip: [[f32; 2]; 3]) -> Vec<[f32; N]> {
    let mut polygon = subject.to_vec();
    for edge in 0..3 {
        let start = clip[edge];
        let end = clip[(edge + 1) % 3];
        let input = std::mem::take(&mut polygon);
        let Some(mut previous) = input.last().copied() else {
            break;
        };
        let mut previous_distance = edge_distance(start, end, previous);
        for current in input {
            let current_distance = edge_distance(start, end, current);
            let previous_inside = previous_distance >= -1e-6;
            let current_inside = current_distance >= -1e-6;
            if previous_inside != current_inside {
                polygon.push(intersection(
                    previous,
                    current,
                    previous_distance,
                    current_distance,
                ));
            }
            if current_inside {
                polygon.push(current);
            }
            previous = current;
            previous_distance = current_distance;
        }
    }
    polygon
}

fn edge_distance<const N: usize>(start: [f32; 2], end: [f32; 2], point: [f32; N]) -> f32 {
    (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0])
}

fn intersection<const N: usize>(
    start: [f32; N],
    end: [f32; N],
    start_distance: f32,
    end_distance: f32,
) -> [f32; N] {
    let denominator = start_distance - end_distance;
    let t = if denominator.abs() <= f32::EPSILON {
        0.0
    } else {
        (start_distance / denominator).clamp(0.0, 1.0)
    };
    let mut output = [0.0; N];
    for index in 0..N {
        output[index] = start[index] + (end[index] - start[index]) * t;
    }
    output
}

fn vertex_cross<const N: usize>(a: [f32; N], b: [f32; N], c: [f32; N]) -> f32 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn to_f32(point: Point) -> [f32; 2] {
    [point[0] as f32, point[1] as f32]
}
