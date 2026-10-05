use std::{collections::HashMap, fmt};

use serde::{Deserialize, Serialize};

use super::{
    Deep2dAtlasQuad, Deep2dCommand, Deep2dDisplayList, Deep2dPaintData, Deep2dRect, Deep2dResource,
    FillRule,
    paint_registry::PaintRegistry,
    painter_atlas::{prepare_image, prepare_text},
    painter_clip::ClipSets,
    painter_prepare::prepare_path,
    validate_display_list,
};

/// Path-stage vertex layout v2 (36 bytes): canvas position (logical, drawn
/// through the letterbox uniform), straight-alpha solid color, LOCAL
/// pre-transform position (gradient evaluation space) and the paint storage
/// slot (0 = solid, render from the vertex color; >0 = storage entry).
pub type PathVertex = [f32; 9];

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
    /// 刀 3:本帧走 stencil-then-cover 的命令数(自动分路结果)。
    pub dynamic_commands: usize,
    /// 本帧动态 fence 边数(每边 6 顶点,canvas 空间)。
    pub dynamic_edges: usize,
    /// 因预算/资格不满足而回落静态 CPU 细分的动态候选数。
    pub dynamic_fallbacks: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreparedDeep2dPathChunk {
    pub z_order: i32,
    pub source_index: usize,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub clip_rect: Option<Deep2dRect>,
}

/// 刀 3 stencil 动态块的准备产物:edge 区间指 `dynamic_edges`(fence 三角
/// 形汤,独立顶点布局),cover 区间指 `vertices`(PathVertex bbox quad,
/// fill/clear 管线消费)。每个动态块自 bracket(clear→cover→fill),
/// chunk 间禁止合并——stencil 是逐块复用的。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreparedDynamicPathChunk {
    pub z_order: i32,
    pub source_index: usize,
    /// fill pass / clear pass 的 cover 顶点区间(`vertices` 流内)。
    pub cover_first: u32,
    pub cover_count: u32,
    /// cover pass 的 fence 顶点区间(`dynamic_edges` 流内,顶点数)。
    pub edge_first: u32,
    pub edge_count: u32,
    pub fill_rule: FillRule,
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
    pub vertices: Vec<PathVertex>,
    /// Paint storage entries referenced by `vertices` paint slots (slot i =
    /// `paints[i]`; slot 0 is the reserved solid dummy).
    pub paints: Vec<Deep2dPaintData>,
    pub chunks: Vec<PreparedDeep2dPathChunk>,
    /// 刀 3:动态命令的 fence 三角形汤(canvas 空间,`[f32; 2]` 位置)。
    pub dynamic_edges: Vec<[f32; 2]>,
    /// 刀 3:动态命令块(与 chunks 同 z 序,由 runtime 层合并排序)。
    pub dynamic_chunks: Vec<PreparedDynamicPathChunk>,
    pub images: Vec<PreparedDeep2dImage>,
    pub glyphs: Vec<PreparedDeep2dGlyph>,
    pub summary: PreparedDeep2dSummary,
}

/// 已定格的整帧路径资源与物理缩放，缓存见证和几何细分共用。
pub(super) struct PathPrepareFrame<'a> {
    pub scale_factor: f64,
    pub paths: &'a HashMap<&'a str, (usize, &'a super::PathResource)>,
}

/// 缓存准备的路由结果:静态(CPU 细分顶点已入 `vertices`)或动态
/// (stencil 发射完成,区间由本层补齐 z/clip/源索引元数据后登记)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum PathPrepareRoute {
    Static,
    Dynamic(DynamicEmission),
}

/// 一次动态发射的顶点区间(fence 在 `dynamic_edges`,cover/描边在
/// `vertices`)。`stroke` 是动态命令回退 CPU 展开的描边区间,由本层
/// 追加一个静态 chunk 保证被绘制。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DynamicEmission {
    pub cover_first: u32,
    pub cover_count: u32,
    pub edge_first: u32,
    pub edge_count: u32,
    pub fill_rule: FillRule,
    pub stroke: Option<(u32, u32)>,
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
        paints: Vec::new(),
        chunks: Vec::new(),
        dynamic_edges: Vec::new(),
        dynamic_chunks: Vec::new(),
        images: Vec::new(),
        glyphs: Vec::new(),
        summary: PreparedDeep2dSummary {
            commands: display_list.commands.len(),
            path_segments: 0,
            fill_triangles: 0,
            stroke_triangles: 0,
            vertices: 0,
            dynamic_commands: 0,
            dynamic_edges: 0,
            dynamic_fallbacks: 0,
        },
    };
    let frame = PathPrepareFrame {
        scale_factor,
        paths: &paths,
    };
    let mut registry = PaintRegistry::default();
    let mut issues = Vec::new();
    for (index, command) in ordered {
        let path = format!("commands[{index}]");
        match command {
            Deep2dCommand::Path(command) => {
                let (resource_index, resource) = paths[command.path_id.as_str()];
                let first_vertex = output.vertices.len() as u32;
                let before_dynamic = output.dynamic_chunks.len();
                let result = if let Some(cache) = cache.as_deref_mut() {
                    cache.prepare(
                        command,
                        resource,
                        &format!("resources[{resource_index}]"),
                        &path,
                        &frame,
                        &mut registry,
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
                        &mut registry,
                        &mut output,
                    )
                    .map(|()| PathPrepareRoute::Static)
                };
                match result {
                    Ok(route) => match route {
                        PathPrepareRoute::Static => {
                            if output.vertices.len() as u32 > first_vertex {
                                output.chunks.push(PreparedDeep2dPathChunk {
                                    z_order: command.z_order,
                                    source_index: index,
                                    first_vertex,
                                    vertex_count: output.vertices.len() as u32 - first_vertex,
                                    clip_rect: command.clip_rect,
                                });
                            }
                        }
                        PathPrepareRoute::Dynamic(emission) => {
                            output.summary.dynamic_commands += 1;
                            output.dynamic_chunks.push(PreparedDynamicPathChunk {
                                z_order: command.z_order,
                                source_index: index,
                                cover_first: emission.cover_first,
                                cover_count: emission.cover_count,
                                edge_first: emission.edge_first,
                                edge_count: emission.edge_count,
                                fill_rule: emission.fill_rule,
                                clip_rect: command.clip_rect,
                            });
                            if let Some((first, count)) = emission.stroke {
                                output.chunks.push(PreparedDeep2dPathChunk {
                                    z_order: command.z_order,
                                    source_index: index,
                                    first_vertex: first,
                                    vertex_count: count,
                                    clip_rect: command.clip_rect,
                                });
                            }
                            debug_assert_eq!(before_dynamic + 1, output.dynamic_chunks.len());
                        }
                    },
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
    output.paints = registry.finish();
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
