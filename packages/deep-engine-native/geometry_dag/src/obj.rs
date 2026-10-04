//! Wavefront OBJ 解析(编译管线输入)。
//!
//! 支持子集:`v`(3-4 分量,w 忽略)、`f`(严格三角形;`v`、`v/vt`、`v//vn`、
//! `v/vt/vn` 四种形式;1-based 正索引与负索引)。多边形面显式拒绝——离线编译
//! 不允许静默三角化改变拓扑;需要时上游先用权威工具扇形化。

use crate::error::{DagError, DagResult};
use crate::types::IndexedGeometry;

/// 解析 OBJ 文本为索引化三角形网格。
///
/// # Errors
/// 非三角形面、非法分量数、索引越界、非法数值均返回带行号的 [`DagError::ObjParse`]。
pub fn parse_obj(text: &str) -> DagResult<IndexedGeometry> {
    let mut positions: Vec<f32> = Vec::new();
    let mut raw_faces: Vec<[usize; 3]> = Vec::new();

    for (line_no, raw_line) in text.lines().enumerate() {
        let line_no = line_no + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut tokens = line.split_whitespace();
        let tag = tokens.next().unwrap_or_default();
        match tag {
            "v" => {
                let coords: Vec<f32> = tokens
                    .map(|t| parse_f32(t, line_no))
                    .collect::<DagResult<_>>()?;
                if coords.len() < 3 {
                    return Err(DagError::ObjParse {
                        line: line_no,
                        reason: format!("vertex needs 3 (optionally 4 with w) components, got {}", coords.len()),
                    });
                }
                if !coords[..3].iter().all(|v| v.is_finite()) {
                    return Err(DagError::ObjParse { line: line_no, reason: "vertex component must be finite".into() });
                }
                positions.extend_from_slice(&coords[..3]);
            }
            "f" => {
                let indices: Vec<usize> = tokens
                    .map(|t| parse_face_vertex(t, line_no, positions.len() / 3))
                    .collect::<DagResult<_>>()?;
                if indices.len() != 3 {
                    return Err(DagError::ObjParse {
                        line: line_no,
                        reason: format!("only triangle faces are supported, got {} vertices", indices.len()),
                    });
                }
                raw_faces.push([indices[0], indices[1], indices[2]]);
            }
            // v/vt/vn、组合、渲染属性等标签与编译无关,跳过。
            _ => {}
        }
    }

    let mut indices = Vec::with_capacity(raw_faces.len() * 3);
    for (face_no, face) in raw_faces.iter().enumerate() {
        for &vertex in face {
            if vertex >= positions.len() / 3 {
                return Err(DagError::ObjParse {
                    line: 0,
                    reason: format!("face {} references vertex {} beyond {} defined", face_no + 1, vertex + 1, positions.len() / 3),
                });
            }
            indices.push(vertex as u32);
        }
    }
    Ok(IndexedGeometry { positions, indices })
}

/// 解析 f32 分量(fail-closed,含定位)。
fn parse_f32(token: &str, line_no: usize) -> DagResult<f32> {
    token
        .parse::<f32>()
        .map_err(|_| DagError::ObjParse { line: line_no, reason: format!("invalid number: {token:?}") })
}

/// 解析面顶点:`v`、`v/vt`、`v//vn`、`v/vt/vn`;1-based 正索引与负索引(相对当前)。
/// 仅返回位置槽(vt/vn 槽位与编译无关)。
fn parse_face_vertex(token: &str, line_no: usize, vertex_count: usize) -> DagResult<usize> {
    let vertex_str = token.split('/').next().unwrap_or_default();
    let raw: i64 = vertex_str
        .parse::<i64>()
        .map_err(|_| DagError::ObjParse { line: line_no, reason: format!("invalid face index: {token:?}") })?;
    if raw == 0 {
        return Err(DagError::ObjParse { line: line_no, reason: "face index 0 is not valid OBJ".into() });
    }
    if raw > 0 {
        Ok((raw - 1) as usize)
    } else {
        if vertex_count == 0 {
            return Err(DagError::ObjParse { line: line_no, reason: "negative face index before any vertex".into() });
        }
        let resolved = vertex_count as i64 + raw;
        Ok(resolved as usize)
    }
}

/// 将几何写为 OBJ 文本(诊断/回归对比用)。Rust f32 `Display` 本身保证 round-trip。
#[must_use]
pub fn write_obj(geometry: &IndexedGeometry, comment: &str) -> String {
    let mut out = String::with_capacity(geometry.positions.len() * 16 + geometry.indices.len() * 16);
    out.push_str("# ");
    out.push_str(comment);
    out.push('\n');
    for tri in geometry.positions.chunks_exact(3) {
        out.push_str(&format!("v {} {} {}\n", tri[0], tri[1], tri[2]));
    }
    for face in geometry.indices.chunks_exact(3) {
        out.push_str(&format!("f {} {} {}\n", face[0] + 1, face[1] + 1, face[2] + 1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2 3\nf 2 4 3\n# comment\n";

    #[test]
    fn parses_triangles() {
        let g = parse_obj(SAMPLE).expect("parse");
        assert_eq!(g.vertex_count(), 4);
        assert_eq!(g.triangle_count(), 2);
        assert_eq!(g.indices, [0, 1, 2, 1, 3, 2]);
    }

    #[test]
    fn parses_slash_forms_and_negative_indices() {
        let text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1/1 2//1 -1\n";
        let g = parse_obj(text).expect("parse");
        assert_eq!(g.triangle_count(), 1);
        assert_eq!(g.indices, [0, 1, 2]);
    }

    #[test]
    fn rejects_polygon_face() {
        let text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2 3 4\n";
        let err = parse_obj(text).unwrap_err();
        assert!(err.to_string().contains("only triangle faces"), "{err}");
    }

    #[test]
    fn rejects_out_of_range_index() {
        let text = "v 0 0 0\nf 1 2 3\n";
        let err = parse_obj(text).unwrap_err();
        assert!(err.to_string().contains("beyond"), "{err}");
    }

    #[test]
    fn rejects_garbage_numbers() {
        let text = "v zero 0 0\n";
        assert!(parse_obj(text).is_err());
        let text2 = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 x 3\n";
        assert!(parse_obj(text2).is_err());
    }

    #[test]
    fn rejects_non_finite_vertex() {
        let text = "v nan 0 0\n";
        assert!(parse_obj(text).is_err());
    }

    #[test]
    fn empty_input_is_empty_mesh() {
        let g = parse_obj("").expect("parse");
        assert_eq!(g.triangle_count(), 0);
    }

    #[test]
    fn obj_roundtrip_text() {
        let g = parse_obj(SAMPLE).expect("parse");
        let text = write_obj(&g, "roundtrip");
        let g2 = parse_obj(&text).expect("reparse");
        assert_eq!(g.positions, g2.positions);
        assert_eq!(g.indices, g2.indices);
    }
}
