//! CPU 权威参考镜像(oracle):与 `native_deep2d_v1.wgsl` v2 同公式地评估
//! 渐变/圆角矩形/阴影,并把 `PreparedDeep2d` 的 9 分量路径顶点光栅化成
//! RGBA8 像素。GPU readback 测试用它对拍;内部逐分支镜像
//! `paint_data` 的 f32 公式(letterbox 映射与 `raster_reference` 同源)。
//!
//! 对拍纪律:插值与公式全部 f32,与 GPU 一致;像素中心采样;直通 alpha
//! 混合与 ALPHA_BLENDING 管线状态一致。

use crate::deep2d::paint_data::{DEEP2D_PAINT_KIND_QUAD, paint_color, quad_fragment};
use crate::deep2d::{
    FillRule, LetterboxMapping, PathVertex, PreparedDeep2d, PreparedDynamicPathChunk,
};

/// Chunk boundary shim (first_vertex/vertex_count) so the rasterizer can
/// scope single-write rules without borrowing the full chunk type.
struct PreparedChunkShim {
    first_vertex: u32,
    vertex_count: u32,
}

/// Rasterizes the prepared path vertices with the mirrored paint formulas.
/// Returns straight-alpha RGBA8 pixels (transparent background).
///
/// 刀 3:动态(stencil)块与静态块按 (z_order, source_index) 合并成同一
/// 绘制序列,混合序与 GPU `build_chunks` 的 ZOrdered 口径一致;动态块用
/// fence 边带做逐像素 winding/parity 判定——与 GPU stencil-then-cover 的
/// 1× 中心采样同语义(细节见 `rasterize_dynamic_chunk`)。
pub fn rasterize_prepared(
    logical: [f64; 2],
    physical: [u32; 2],
    prepared: &PreparedDeep2d,
) -> Vec<[u8; 4]> {
    let width = physical[0];
    let height = physical[1];
    let mut pixels = vec![[0u8, 0, 0, 0]; (width * height) as usize];
    if logical[0] <= 0.0 || logical[1] <= 0.0 || width == 0 || height == 0 {
        return pixels;
    }
    let mapping = LetterboxMapping::new(logical, [f64::from(width), f64::from(height)]);
    // Hand-built fixtures may carry no chunk metadata: the whole vertex
    // stream then behaves as one command.
    let _fallback = [PreparedChunkShim {
        first_vertex: 0,
        vertex_count: prepared.vertices.len() as u32,
    }];
    // Draw sequence: static path chunks + dynamic chunks interleaved by
    // (z_order, source_index), matching the ZOrdered build_chunks sort.
    let mut sequence: Vec<DrawItem<'_>> = prepared
        .chunks
        .iter()
        .map(|chunk| DrawItem::Static {
            z_order: chunk.z_order,
            source_index: chunk.source_index,
            chunk: PreparedChunkShim {
                first_vertex: chunk.first_vertex,
                vertex_count: chunk.vertex_count,
            },
        })
        .chain(prepared.dynamic_chunks.iter().map(|chunk| DrawItem::Dynamic {
            z_order: chunk.z_order,
            source_index: chunk.source_index,
            chunk,
        }))
        .collect();
    if prepared.chunks.is_empty() && prepared.dynamic_chunks.is_empty() {
        sequence.push(DrawItem::Static {
            z_order: 0,
            source_index: 0,
            chunk: PreparedChunkShim {
                first_vertex: 0,
                vertex_count: prepared.vertices.len() as u32,
            },
        });
    }
    sequence.sort_by_key(|item| match item {
        DrawItem::Static {
            z_order,
            source_index,
            ..
        }
        | DrawItem::Dynamic {
            z_order,
            source_index,
            ..
        } => (*z_order, *source_index),
    });
    for item in &sequence {
        // Adjacent triangles within one command share edges; a pixel center
        // landing exactly on a shared edge belongs to exactly ONE GPU triangle
        // (top-left rule). The reference must not blend it twice, so each pixel
        // writes at most once per chunk. Overlapping commands (drawn in order)
        // blend normally across chunks.
        let mut written = vec![false; pixels.len()];
        match item {
            DrawItem::Static { chunk, .. } => {
                if chunk.vertex_count == 0 {
                    continue;
                }
                rasterize_static_chunk(prepared, chunk, &mapping, &mut pixels, &mut written);
            }
            DrawItem::Dynamic { chunk, .. } => {
                rasterize_dynamic_chunk(prepared, chunk, &mapping, &mut pixels, &mut written);
            }
        }
    }
    pixels
}

enum DrawItem<'a> {
    Static {
        z_order: i32,
        source_index: usize,
        chunk: PreparedChunkShim,
    },
    Dynamic {
        z_order: i32,
        source_index: usize,
        chunk: &'a PreparedDynamicPathChunk,
    },
}

fn rasterize_static_chunk(
    prepared: &PreparedDeep2d,
    chunk: &PreparedChunkShim,
    mapping: &LetterboxMapping,
    pixels: &mut [[u8; 4]],
    written: &mut [bool],
) {
    let width = mapping.physical[0] as u32;
    let height = mapping.physical[1] as u32;
    let vertex_range =
        chunk.first_vertex as usize..(chunk.first_vertex + chunk.vertex_count) as usize;
    for triangle in prepared.vertices[vertex_range].chunks_exact(3) {
        // Physical-space triangle; attributes interpolate linearly like the
        // GPU (orthographic projection keeps screen-space barycentrics exact).
        let mut corners = [[0.0f64; 2]; 3];
        for (corner, vertex) in corners.iter_mut().zip(triangle.iter()) {
            *corner = mapping.logical_to_physical([f64::from(vertex[0]), f64::from(vertex[1])]);
        }
        let xs = [corners[0][0], corners[1][0], corners[2][0]];
        let ys = [corners[0][1], corners[1][1], corners[2][1]];
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min).floor().max(0.0) as u32;
        let max_x = xs
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            .min(f64::from(width - 1)) as u32;
        let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min).floor().max(0.0) as u32;
        let max_y = ys
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            .min(f64::from(height - 1)) as u32;
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                let center = [f64::from(x) + 0.5, f64::from(y) + 0.5];
                let Some(weights) = barycentric(center, &corners) else {
                    continue;
                };
                let index = (y * width + x) as usize;
                if written[index] {
                    continue;
                }
                written[index] = true;
                let (local, slot, color) = interpolate(
                    triangle
                        .try_into()
                        .expect("triangles are triplets"),
                    weights,
                );
                let shaded = shade(prepared, slot, local, color);
                pixels[index] = blend_over(pixels[index], shaded);
            }
        }
    }
}

/// 刀 3 stencil 动态块的 CPU 镜像:fence 边带(每边 6 顶点 = 两个三角形,
/// 前 2 个顶点是边的端点)做逐像素 winding/parity 判定,cover quad 提供
/// paint 求值。半开区间规则与 GPU 光栅化的中心采样对齐:
/// - 穿越判定 `(a.y <= cy) != (b.y <= cy)`(顶点落在扫描线上算下方),
/// - 交叉点严格在中心右侧 `x_int > cx`。
/// nonzero:|winding| != 0;evenodd:穿越数为奇。朝向约定在两侧一致地
/// 不影响判定(nonzero 测试对全局符号翻转不变)。
fn rasterize_dynamic_chunk(
    prepared: &PreparedDeep2d,
    chunk: &PreparedDynamicPathChunk,
    mapping: &LetterboxMapping,
    pixels: &mut [[u8; 4]],
    written: &mut [bool],
) {
    let width = mapping.physical[0] as u32;
    let height = mapping.physical[1] as u32;
    let edge_vertices = chunk.edge_count as usize;
    if edge_vertices == 0 || chunk.cover_count < 6 {
        return;
    }
    let edges = &prepared.dynamic_edges
        [chunk.edge_first as usize..(chunk.edge_first as usize + edge_vertices)];
    let cover = &prepared.vertices
        [chunk.cover_first as usize..(chunk.cover_first + chunk.cover_count) as usize];
    // 边端点与 bbox 都取自顶点流的 canvas 坐标,映射到物理空间后判定。
    let physical_edges: Vec<[[f64; 2]; 2]> = edges
        .chunks_exact(6)
        .map(|edge| {
            [
                mapping.logical_to_physical([f64::from(edge[0][0]), f64::from(edge[0][1])]),
                mapping.logical_to_physical([f64::from(edge[1][0]), f64::from(edge[1][1])]),
            ]
        })
        .collect();
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for [a, b] in &physical_edges {
        for point in [a, b] {
            for axis in 0..2 {
                min[axis] = min[axis].min(point[axis]);
                max[axis] = max[axis].max(point[axis]);
            }
        }
    }
    let min_x = (min[0].floor().max(0.0) as u32).min(width.saturating_sub(1));
    let min_y = (min[1].floor().max(0.0) as u32).min(height.saturating_sub(1));
    let max_x = (max[0].ceil().min(f64::from(width - 1)).max(0.0)) as u32;
    let max_y = (max[1].ceil().min(f64::from(height - 1)).max(0.0)) as u32;
    if min_x > max_x || min_y > max_y {
        return;
    }
    let first_cover = cover[0];
    let slot = (first_cover[8].round().max(0.0)) as u32;
    let color = [first_cover[2], first_cover[3], first_cover[4], first_cover[5]];
    // cover quad 的局部坐标端点:顶点 0 = bbox 最小角,顶点 2 = 最大角
    // (cover_vertices 的发射顺序)。bbox 内线性插值 = 逆变换精确值。
    let local_min = [f64::from(first_cover[6]), f64::from(first_cover[7])];
    let local_max_corner = cover[2];
    let local_max = [f64::from(local_max_corner[6]), f64::from(local_max_corner[7])];
    let canvas_min = [f64::from(first_cover[0]), f64::from(first_cover[1])];
    let canvas_max_corner = cover[2];
    let canvas_max = [
        f64::from(canvas_max_corner[0]),
        f64::from(canvas_max_corner[1]),
    ];
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let center = [f64::from(x) + 0.5, f64::from(y) + 0.5];
            let mut winding = 0i64;
            for [a, b] in &physical_edges {
                let crosses = (a[1] <= center[1]) != (b[1] <= center[1]);
                if !crosses {
                    continue;
                }
                let slope = (b[0] - a[0]) / (b[1] - a[1]);
                let x_int = a[0] + (center[1] - a[1]) * slope;
                if x_int > center[0] {
                    winding += if b[1] > a[1] { 1 } else { -1 };
                }
            }
            let inside = match chunk.fill_rule {
                FillRule::Nonzero => winding != 0,
                FillRule::Evenodd => winding.rem_euclid(2) != 0,
            };
            if !inside {
                continue;
            }
            let index = (y * width + x) as usize;
            if written[index] {
                continue;
            }
            written[index] = true;
            // local 由 cover 端点线性插值(canvas bbox 轴对齐 → 仿射线性,
            // 与 GPU 重心插值同结果)。
            let logical = mapping.physical_to_logical(center);
            let mut local = [0.0f32; 2];
            for axis in 0..2 {
                let span = canvas_max[axis] - canvas_min[axis];
                let fraction = if span.abs() > 1e-12 {
                    ((logical[axis] - canvas_min[axis]) / span).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                local[axis] = (local_min[axis] + (local_max[axis] - local_min[axis]) * fraction)
                    as f32;
            }
            let shaded = shade(prepared, slot, local, color);
            pixels[index] = blend_over(pixels[index], shaded);
        }
    }
}

/// Evaluates one fragment exactly like the WGSL: slot 0 returns the vertex
/// color; gradients scale their stop alpha by the entry opacity; quads run
/// the analytic shadow/fill/stroke composite.
fn shade(
    prepared: &PreparedDeep2d,
    slot: u32,
    local: [f32; 2],
    color: [f32; 4],
) -> [f32; 4] {
    if slot == 0 {
        return color;
    }
    let Some(entry) = prepared.paints.get(slot as usize) else {
        return [0.0; 4];
    };
    if entry.kind == DEEP2D_PAINT_KIND_QUAD {
        quad_fragment(entry, &prepared.paints, local)
    } else {
        paint_color(entry, local)
    }
}

/// Screen-space barycentric weights; `None` on degenerate triangles. Uses the
/// same inclusive edge rule as `raster_reference::point_in_triangle`.
fn barycentric(point: [f64; 2], corners: &[[f64; 2]; 3]) -> Option<[f64; 3]> {
    let area = cross(corners[0], corners[1], corners[2]);
    if area.abs() <= 1e-12 {
        return None;
    }
    let w0 = cross(corners[1], corners[2], point) / area;
    let w1 = cross(corners[2], corners[0], point) / area;
    let w2 = cross(corners[0], corners[1], point) / area;
    let has_negative = w0 < 0.0 || w1 < 0.0 || w2 < 0.0;
    let has_positive = w0 > 0.0 || w1 > 0.0 || w2 > 0.0;
    if has_negative && has_positive {
        return None;
    }
    Some([w0, w1, w2])
}

fn cross(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn interpolate(triangle: &[PathVertex; 3], weights: [f64; 3]) -> ([f32; 2], u32, [f32; 4]) {
    let mut local = [0.0f32; 2];
    let mut color = [0.0f32; 4];
    let mut slot = 0.0f32;
    for (vertex, weight) in triangle.iter().zip(weights.iter()) {
        let w = *weight as f32;
        for axis in 0..2 {
            local[axis] += vertex[6 + axis] * w;
        }
        for channel in 0..4 {
            color[channel] += vertex[2 + channel] * w;
        }
        slot += vertex[8] * w;
    }
    (local, slot.round().max(0.0) as u32, color)
}

/// Straight-alpha over with RGBA8 quantization; mirrors `raster_reference`
/// and the GPU ALPHA_BLENDING state.
fn blend_over(destination: [u8; 4], source: [f32; 4]) -> [u8; 4] {
    let below = [
        f64::from(destination[0]) / 255.0,
        f64::from(destination[1]) / 255.0,
        f64::from(destination[2]) / 255.0,
        f64::from(destination[3]) / 255.0,
    ];
    let blended = [
        f64::from(source[0]) * f64::from(source[3]) + below[0] * (1.0 - f64::from(source[3])),
        f64::from(source[1]) * f64::from(source[3]) + below[1] * (1.0 - f64::from(source[3])),
        f64::from(source[2]) * f64::from(source[3]) + below[2] * (1.0 - f64::from(source[3])),
        f64::from(source[3]) + below[3] * (1.0 - f64::from(source[3])),
    ];
    [
        (blended[0] * 255.0).round().clamp(0.0, 255.0) as u8,
        (blended[1] * 255.0).round().clamp(0.0, 255.0) as u8,
        (blended[2] * 255.0).round().clamp(0.0, 255.0) as u8,
        (blended[3] * 255.0).round().clamp(0.0, 255.0) as u8,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deep2d::paint_data::{
        DEEP2D_MAX_GRADIENT_STOPS, DEEP2D_PAINT_KIND_LINEAR, Deep2dPaintData, Deep2dPaintStop,
    };
    use crate::deep2d::PreparedDeep2dSummary;

    fn vertex(canvas: [f32; 2], color: [f32; 4], local: [f32; 2], slot: u32) -> PathVertex {
        [
            canvas[0], canvas[1], color[0], color[1], color[2], color[3], local[0], local[1],
            slot as f32,
        ]
    }

    fn gradient_entry() -> Deep2dPaintData {
        let mut stops = [Deep2dPaintStop::default(); DEEP2D_MAX_GRADIENT_STOPS];
        stops[0] = Deep2dPaintStop::new(0.0, [1.0, 0.0, 0.0, 1.0]);
        stops[1] = Deep2dPaintStop::new(1.0, [0.0, 0.0, 1.0, 1.0]);
        Deep2dPaintData {
            kind: DEEP2D_PAINT_KIND_LINEAR,
            p0: [1.0, 0.0],
            p1: [3.0, 0.0],
            stop_count: 2,
            stops,
            ..Default::default()
        }
    }

    fn prepared(entries: Vec<Deep2dPaintData>, vertices: Vec<PathVertex>) -> PreparedDeep2d {
        PreparedDeep2d {
            logical_width: 4.0,
            logical_height: 4.0,
            vertices,
            paints: entries,
            chunks: Vec::new(),
            dynamic_edges: Vec::new(),
            dynamic_chunks: Vec::new(),
            images: Vec::new(),
            glyphs: Vec::new(),
            summary: PreparedDeep2dSummary {
                commands: 0,
                path_segments: 0,
                fill_triangles: 0,
                stroke_triangles: 0,
                vertices: 0,
                dynamic_commands: 0,
                dynamic_edges: 0,
                dynamic_fallbacks: 0,
            },
        }
    }

    #[test]
    fn solid_slots_render_from_vertex_color() {
        // Quad covering logical [1, 3]^2: pixel (0,0) stays empty, interior
        // pixel (1,1) fills.
        let corners = [[1.0, 1.0], [3.0, 1.0], [3.0, 3.0], [1.0, 3.0]];
        let color = [1.0f32, 0.0, 0.0, 1.0];
        let vertices = vec![
            vertex(corners[0], color, corners[0], 0),
            vertex(corners[1], color, corners[1], 0),
            vertex(corners[2], color, corners[2], 0),
            vertex(corners[0], color, corners[0], 0),
            vertex(corners[2], color, corners[2], 0),
            vertex(corners[3], color, corners[3], 0),
        ];
        let pixels = rasterize_prepared([4.0, 4.0], [4, 4], &prepared(Vec::new(), vertices));
        assert_eq!(pixels[4 + 1], [255, 0, 0, 255]);
        assert_eq!(pixels[0], [0, 0, 0, 0], "outside the quad stays empty");
    }

    #[test]
    fn gradient_slots_evaluate_the_ramp_per_pixel() {
        // Quad [1, 3]^2 with the ramp spanning local x in [1, 3]: pixel
        // centers land at t = 0.25 and t = 0.75 of a red->blue ramp.
        let corners = [[1.0, 1.0], [3.0, 1.0], [3.0, 3.0], [1.0, 3.0]];
        let color = [1.0f32, 0.0, 0.0, 1.0];
        let vertices = vec![
            vertex(corners[0], color, corners[0], 1),
            vertex(corners[1], color, corners[1], 1),
            vertex(corners[2], color, corners[2], 1),
            vertex(corners[0], color, corners[0], 1),
            vertex(corners[2], color, corners[2], 1),
            vertex(corners[3], color, corners[3], 1),
        ];
        let prepared = prepared(vec![Default::default(), gradient_entry()], vertices);
        let pixels = rasterize_prepared([4.0, 4.0], [4, 4], &prepared);
        let near = |pixel: [u8; 4], expected: [f64; 4]| {
            pixel
                .iter()
                .zip(expected.iter())
                .all(|(channel, target)| (f64::from(*channel) - target * 255.0).abs() <= 2.0)
        };
        // t = 0.25: lerp([1,0,0,1],[0,0,1,1]) = [0.75, 0, 0.25, 1].
        assert!(near(pixels[4 + 1], [0.75, 0.0, 0.25, 1.0]));
        // t = 0.75: [0.25, 0, 0.75, 1].
        assert!(near(pixels[4 + 2], [0.25, 0.0, 0.75, 1.0]));
        assert_eq!(pixels[0], [0, 0, 0, 0], "outside the quad stays empty");
    }
}
