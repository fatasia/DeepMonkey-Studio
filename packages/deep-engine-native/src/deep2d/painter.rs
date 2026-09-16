use std::{collections::HashMap, fmt};

use serde::{Deserialize, Serialize};

use super::{
    Deep2dAtlasQuad, Deep2dCommand, Deep2dDisplayList, Deep2dRect, Deep2dResource,
    painter_atlas::{prepare_image, prepare_text},
    painter_clip::ClipSets,
    painter_prepare::prepare_path,
    validate_display_list,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Deep2dPainterIssueCode {
    InvalidDisplayList,
    UnsupportedCommand,
    UnsupportedPathVerb,
    UnsupportedClip,
    UnsupportedDash,
    UnsupportedStyle,
    UnsupportedGeometry,
    TessellationBudgetExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deep2dPainterIssue {
    pub code: Deep2dPainterIssueCode,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deep2dPainterError {
    pub issues: Vec<Deep2dPainterIssue>,
}

impl fmt::Display for Deep2dPainterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Some(first) = self.issues.first() else {
            return formatter.write_str("Deep2d painter rejected the display list");
        };
        write!(
            formatter,
            "Deep2d painter rejected {:?} at {}: {}",
            first.code, first.path, first.message
        )
    }
}

impl std::error::Error for Deep2dPainterError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreparedDeep2dSummary {
    pub commands: usize,
    pub path_segments: usize,
    pub fill_triangles: usize,
    pub stroke_triangles: usize,
    pub vertices: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreparedDeep2dPathChunk {
    pub z_order: i32,
    pub source_index: usize,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub clip_rect: Option<Deep2dRect>,
}

/// An image quad validated against a display-list atlas, kept in painter draw
/// order; the runtime layer resolves pixels and interleaves it by z-order.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedDeep2dImage {
    pub quad: Deep2dAtlasQuad,
    pub source_index: usize,
    pub clip_rect: Option<Deep2dRect>,
    pub(super) clip_sets: ClipSets,
}

/// A host-shaped glyph resolved to an existing display-list atlas.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedDeep2dGlyph {
    pub quad: Deep2dAtlasQuad,
    pub source_index: usize,
    pub clip_rect: Option<Deep2dRect>,
    pub(super) clip_sets: ClipSets,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedDeep2d {
    pub logical_width: f32,
    pub logical_height: f32,
    pub vertices: Vec<[f32; 6]>,
    pub chunks: Vec<PreparedDeep2dPathChunk>,
    pub images: Vec<PreparedDeep2dImage>,
    pub glyphs: Vec<PreparedDeep2dGlyph>,
    pub summary: PreparedDeep2dSummary,
}

/// 已定格的整帧路径资源与物理缩放，缓存见证和几何细分共用。
pub(super) struct PathPrepareFrame<'a> {
    pub scale_factor: f64,
    pub paths: &'a HashMap<&'a str, (usize, &'a super::PathResource)>,
}

pub fn prepare_display_list(
    display_list: &Deep2dDisplayList,
) -> Result<PreparedDeep2d, Deep2dPainterError> {
    prepare_impl(display_list, None, true)
}

pub fn prepare_display_list_cached(
    display_list: &Deep2dDisplayList,
    cache: &mut super::Deep2dPathCache,
) -> Result<PreparedDeep2d, Deep2dPainterError> {
    prepare_impl(display_list, Some(cache), true)
}

pub(super) fn prepare_impl(
    display_list: &Deep2dDisplayList,
    mut cache: Option<&mut super::Deep2dPathCache>,
    finish_frame: bool,
) -> Result<PreparedDeep2d, Deep2dPainterError> {
    let validation = validate_display_list(display_list);
    if !validation.valid {
        return Err(Deep2dPainterError {
            issues: validation
                .issues
                .into_iter()
                .map(|issue| Deep2dPainterIssue {
                    code: Deep2dPainterIssueCode::InvalidDisplayList,
                    path: issue.path,
                    message: format!("{:?}: {}", issue.code, issue.message),
                })
                .collect(),
        });
    }

    let paths = display_list
        .resources
        .iter()
        .enumerate()
        .filter_map(|(index, resource)| match resource {
            Deep2dResource::Path(path) => Some((path.id.as_str(), (index, path))),
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    // 整帧只用这一个物理缩放:path 细分/文字与图片 quad/clip 与缓存见证全部同源。
    // 宿主显式声明相机时以它为准(见 Deep2dGpuPainter::new_with_context);
    // 未声明时退回显示列表自带值,与无缓存路径逐字节一致。
    let scale_factor = match cache.as_deref() {
        Some(cache) => cache.effective_scale(display_list.scale_factor),
        None => display_list.scale_factor,
    };
    let mut ordered = display_list.commands.iter().enumerate().collect::<Vec<_>>();
    ordered.sort_by_key(|(index, command)| (z_order(command), *index));

    let mut output = PreparedDeep2d {
        logical_width: display_list.logical_width as f32,
        logical_height: display_list.logical_height as f32,
        vertices: Vec::new(),
        chunks: Vec::new(),
        images: Vec::new(),
        glyphs: Vec::new(),
        summary: PreparedDeep2dSummary {
            commands: display_list.commands.len(),
            path_segments: 0,
            fill_triangles: 0,
            stroke_triangles: 0,
            vertices: 0,
        },
    };
    let frame = PathPrepareFrame {
        scale_factor,
        paths: &paths,
    };
    let mut issues = Vec::new();
    for (index, command) in ordered {
        let path = format!("commands[{index}]");
        match command {
            Deep2dCommand::Path(command) => {
                let (resource_index, resource) = paths[command.path_id.as_str()];
                let first_vertex = output.vertices.len() as u32;
                let result = if let Some(cache) = cache.as_deref_mut() {
                    cache.prepare(
                        command,
                        resource,
                        &format!("resources[{resource_index}]"),
                        &path,
                        &frame,
                        &mut output,
                    )
                } else {
                    prepare_path(
                        command,
                        resource,
                        &format!("resources[{resource_index}]"),
                        &path,
                        scale_factor,
                        &paths,
                        &mut output,
                    )
                };
                match result {
                    Ok(()) if output.vertices.len() as u32 > first_vertex => {
                        output.chunks.push(PreparedDeep2dPathChunk {
                            z_order: command.z_order,
                            source_index: index,
                            first_vertex,
                            vertex_count: output.vertices.len() as u32 - first_vertex,
                            clip_rect: command.clip_rect,
                        })
                    }
                    Ok(()) => {}
                    Err(issue) => issues.push(issue),
                }
            }
            Deep2dCommand::Text(command) => {
                if let Err(value) =
                    prepare_text(command, index, &path, &paths, scale_factor, &mut output)
                {
                    issues.push(value);
                }
            }
            Deep2dCommand::Image(command) => {
                if let Err(value) =
                    prepare_image(command, index, &path, &paths, scale_factor, &mut output)
                {
                    issues.push(value);
                }
            }
        }
    }
    if !issues.is_empty() {
        return Err(Deep2dPainterError { issues });
    }
    if finish_frame && let Some(cache) = cache {
        let live_ids = display_list
            .commands
            .iter()
            .filter_map(|command| match command {
                Deep2dCommand::Path(command) => Some(command.id.as_str()),
                Deep2dCommand::Text(_) | Deep2dCommand::Image(_) => None,
            });
        cache.prune_to_ids(live_ids);
    }
    output.summary.vertices = output.vertices.len();
    Ok(output)
}

fn z_order(command: &Deep2dCommand) -> i32 {
    match command {
        Deep2dCommand::Path(value) => value.z_order,
        Deep2dCommand::Text(value) => value.z_order,
        Deep2dCommand::Image(value) => value.z_order,
    }
}

pub(super) fn issue(code: Deep2dPainterIssueCode, path: &str, message: &str) -> Deep2dPainterIssue {
    Deep2dPainterIssue {
        code,
        path: path.into(),
        message: message.into(),
    }
}
