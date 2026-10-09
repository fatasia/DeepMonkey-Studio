//! 输入验证:全部 fail-closed,与 TS `inputValidation.ts` 的拒绝条件逐条对应。

use crate::error::{DagError, DagResult};
use crate::types::{
    IndexedGeometry, MESHLET_MAX_TRIANGLES_LIMIT, MESHLET_MAX_VERTICES_LIMIT,
    SOURCE_TRIANGLES_BUDGET, SOURCE_VERTICES_BUDGET,
};

/// 已验证的构建输入。
#[derive(Debug, Clone)]
pub struct ValidatedInput {
    /// 通过验证的几何。
    pub geometry: IndexedGeometry,
    /// 簇顶点上限(1..=64)。
    pub max_vertices: u32,
    /// 簇三角形上限(1..=126)。
    pub max_triangles: u32,
}

/// 验证网格与簇参数;任何非法输入返回带定位信息的错误。
///
/// 校验项与 TS `validateMeshletInput` 一致:positions 为紧凑 XYZ 三元组、indices 为完整
/// 三角形、全部位置分量有限、全部索引落在顶点范围内、顶点/三角形数不超源预算、
/// 簇上限在 `1..=默认上限` 区间内。
///
/// # Errors
/// 见 [`DagError::InvalidInput`] / [`DagError::BudgetExceeded`]。
pub fn validate_input(
    geometry: &IndexedGeometry,
    max_vertices: Option<u32>,
    max_triangles: Option<u32>,
) -> DagResult<ValidatedInput> {
    if !geometry.positions.len().is_multiple_of(3) {
        return Err(DagError::invalid_input(
            "positions must contain tightly packed XYZ triples.",
        ));
    }
    if !geometry.indices.len().is_multiple_of(3) {
        return Err(DagError::invalid_input(
            "indices must contain complete triangles.",
        ));
    }
    let vertex_count = geometry.vertex_count();
    let triangle_count = geometry.triangle_count();
    budget(
        vertex_count as u64,
        SOURCE_VERTICES_BUDGET,
        "source vertices",
    )?;
    budget(
        triangle_count as u64,
        SOURCE_TRIANGLES_BUDGET,
        "source triangles",
    )?;
    if geometry.positions.iter().any(|v| !v.is_finite()) {
        return Err(DagError::invalid_input(
            "Position components must be finite.",
        ));
    }
    for (offset, &index) in geometry.indices.iter().enumerate() {
        if index as usize >= vertex_count {
            return Err(DagError::invalid_input(format!(
                "Index {offset} ({index}) is outside the source vertex range ({vertex_count})."
            )));
        }
    }
    let max_vertices = meshlet_limit(max_vertices, MESHLET_MAX_VERTICES_LIMIT, "maxVertices")?;
    let max_triangles = meshlet_limit(max_triangles, MESHLET_MAX_TRIANGLES_LIMIT, "maxTriangles")?;
    Ok(ValidatedInput {
        geometry: geometry.clone(),
        max_vertices,
        max_triangles,
    })
}

/// TS `budget`:超出上限即报错。
pub(crate) fn budget(value: u64, maximum: u64, label: &str) -> DagResult<()> {
    if value > maximum {
        return Err(DagError::budget_exceeded(label, maximum));
    }
    Ok(())
}

/// TS `meshletLimit`:1..=maximum 的整数上限。
fn meshlet_limit(value: Option<u32>, maximum: u32, label: &str) -> DagResult<u32> {
    let resolved = value.unwrap_or(maximum);
    if resolved < 1 || resolved > maximum {
        return Err(DagError::invalid_input(format!(
            "{label} must be an integer in 1..{maximum}."
        )));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry(vertex_count: usize, triangle_count: usize) -> IndexedGeometry {
        IndexedGeometry {
            positions: vec![0.0; vertex_count * 3],
            indices: vec![0; triangle_count * 3],
        }
    }

    #[test]
    fn accepts_valid_geometry() {
        let mut g = geometry(4, 2);
        g.indices.copy_from_slice(&[0, 1, 2, 1, 2, 3]);
        assert!(validate_input(&g, None, None).is_ok());
    }

    #[test]
    fn rejects_misaligned_arrays() {
        // positions 缺一个分量(2.5 个顶点)。
        let mut g = geometry(2, 1);
        g.positions.truncate(5);
        let err = validate_input(&g, None, None).unwrap_err();
        assert!(err.to_string().contains("tightly packed"), "{err}");
        // indices 缺一个分量(2.5 个三角形)。
        let mut g = geometry(3, 2);
        g.indices.truncate(5);
        let err = validate_input(&g, None, None).unwrap_err();
        assert!(err.to_string().contains("complete triangles"), "{err}");
    }

    #[test]
    fn rejects_out_of_range_index() {
        let mut g = geometry(2, 1);
        g.indices.copy_from_slice(&[0, 1, 2]);
        let err = validate_input(&g, None, None).unwrap_err();
        assert!(err.to_string().contains("outside the source vertex range"));
    }

    #[test]
    fn rejects_non_finite_positions() {
        let mut g = geometry(1, 0);
        g.positions[1] = f32::NAN;
        assert!(validate_input(&g, None, None).is_err());
        g.positions[1] = f32::INFINITY;
        assert!(validate_input(&g, None, None).is_err());
    }

    #[test]
    fn rejects_bad_meshlet_limits() {
        let g = geometry(3, 1);
        assert!(validate_input(&g, Some(0), None).is_err());
        assert!(validate_input(&g, Some(65), None).is_err());
        assert!(validate_input(&g, None, Some(127)).is_err());
        assert!(validate_input(&g, Some(64), Some(126)).is_ok());
    }

    #[test]
    fn rejects_empty_meshlet_limit() {
        let g = geometry(0, 0);
        assert!(validate_input(&g, Some(0), Some(0)).is_err());
    }
}
