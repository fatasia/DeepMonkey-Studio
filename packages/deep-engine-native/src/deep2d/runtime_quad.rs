use super::{Deep2dAtlasKind, Deep2dAtlasQuad, PreparedDeep2dAtlas};

pub(super) fn append_quad(
    vertices: &mut Vec<[f32; 13]>,
    quad: &Deep2dAtlasQuad,
    atlas: &PreparedDeep2dAtlas,
) {
    let [x, y, width, height] = quad.destination;
    let positions = [
        point(quad.transform, x, y),
        point(quad.transform, x + width, y),
        point(quad.transform, x + width, y + height),
        point(quad.transform, x, y + height),
    ];
    let [source_x, source_y, source_width, source_height] = quad.source;
    let left = (source_x as f32 + 0.5) / atlas.width as f32;
    let top = (source_y as f32 + 0.5) / atlas.height as f32;
    let right = ((source_x + source_width) as f32 - 0.5) / atlas.width as f32;
    let bottom = ((source_y + source_height) as f32 - 0.5) / atlas.height as f32;
    // Interpolate texel edges; clamp sampling to this region's texel centers.
    // Insetting vertex UVs shrinks the image and blurs native-size text.
    let edge_left = source_x as f32 / atlas.width as f32;
    let edge_top = source_y as f32 / atlas.height as f32;
    let edge_right = (source_x + source_width) as f32 / atlas.width as f32;
    let edge_bottom = (source_y + source_height) as f32 / atlas.height as f32;
    let uvs = [
        [edge_left, edge_top],
        [edge_right, edge_top],
        [edge_right, edge_bottom],
        [edge_left, edge_bottom],
    ];
    let color = [
        quad.color[0] as f32,
        quad.color[1] as f32,
        quad.color[2] as f32,
        (quad.color[3] * quad.opacity) as f32,
    ];
    let glyph = f32::from(atlas.kind == Deep2dAtlasKind::Glyph);
    for index in [0, 1, 2, 0, 2, 3] {
        vertices.push([
            positions[index][0],
            positions[index][1],
            uvs[index][0],
            uvs[index][1],
            color[0],
            color[1],
            color[2],
            color[3],
            glyph,
            left,
            top,
            right,
            bottom,
        ]);
    }
}

fn point(matrix: [f64; 6], x: f64, y: f64) -> [f32; 2] {
    [
        (matrix[0] * x + matrix[2] * y + matrix[4]) as f32,
        (matrix[1] * x + matrix[3] * y + matrix[5]) as f32,
    ]
}
