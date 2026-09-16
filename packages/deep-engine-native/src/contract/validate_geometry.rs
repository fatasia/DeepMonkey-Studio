use std::collections::{HashMap, HashSet};

use super::{
    GeometryResource,
    uv_sets::{GeometryFeatures, MaterialFeatures},
    validate::{safe_revision, unique_id},
};

const MAX_GEOMETRY_BYTES: usize = 128 * 1024 * 1024;

pub(super) fn validate_geometries(
    geometries: &[GeometryResource],
) -> Result<(HashMap<&str, &GeometryResource>, usize), String> {
    let mut geometry_ids = HashSet::new();
    let mut geometries_by_id = HashMap::new();
    let mut geometry_bytes = 0usize;
    let mut triangles = 0usize;
    for geometry in geometries {
        unique_id(&mut geometry_ids, &geometry.id, "geometry")?;
        safe_revision(geometry.revision, "geometry")?;
        if geometry.vertices.is_empty() || !geometry.vertices.len().is_multiple_of(6) {
            return Err(format!(
                "geometry {} has an invalid vertex layout",
                geometry.id
            ));
        }
        if geometry.indices.is_empty() || !geometry.indices.len().is_multiple_of(3) {
            return Err(format!(
                "geometry {} has an invalid index layout",
                geometry.id
            ));
        }
        let vertex_count = geometry.vertices.len() / 6;
        if let Some(uv0) = &geometry.uv0
            && (uv0.len() != vertex_count * 2 || uv0.iter().any(|value| !value.is_finite()))
        {
            return Err(format!(
                "geometry {} has an invalid UV0 layout",
                geometry.id
            ));
        }
        if let Some(uv1) = &geometry.uv1
            && (uv1.len() != vertex_count * 2 || uv1.iter().any(|value| !value.is_finite()))
        {
            return Err(format!(
                "geometry {} has an invalid UV1 layout",
                geometry.id
            ));
        }
        if let Some(colors) = &geometry.colors
            && (colors.len() != vertex_count * 4 || colors.iter().any(|value| !value.is_finite()))
        {
            return Err(format!(
                "geometry {} has an invalid color layout",
                geometry.id
            ));
        }
        if geometry
            .indices
            .iter()
            .any(|&index| index as usize >= vertex_count)
        {
            return Err(format!(
                "geometry {} contains an out-of-range index",
                geometry.id
            ));
        }
        validate_tangents(geometry, vertex_count)?;
        for vertex in geometry.vertices.chunks_exact(6) {
            if vertex.iter().any(|value| !value.is_finite()) {
                return Err(format!(
                    "geometry {} contains non-finite vertices",
                    geometry.id
                ));
            }
            if (vertex[3] * vertex[3] + vertex[4] * vertex[4] + vertex[5] * vertex[5]).sqrt() < 1e-8
            {
                return Err(format!("geometry {} contains a zero normal", geometry.id));
            }
        }
        geometry_bytes = geometry_bytes
            .checked_add(geometry.vertices.len() * 4 + geometry.indices.len() * 4)
            .and_then(|sum| {
                geometry
                    .uv0
                    .as_ref()
                    .map_or(Some(sum), |uv| sum.checked_add(uv.len() * 4))
            })
            .and_then(|sum| {
                geometry
                    .uv1
                    .as_ref()
                    .map_or(Some(sum), |uv| sum.checked_add(uv.len() * 4))
            })
            .and_then(|sum| {
                geometry
                    .tangents
                    .as_ref()
                    .map_or(Some(sum), |values| sum.checked_add(values.len() * 4))
            })
            .and_then(|sum| {
                geometry
                    .colors
                    .as_ref()
                    .map_or(Some(sum), |values| sum.checked_add(values.len() * 4))
            })
            .ok_or_else(|| "geometry byte count overflow".to_string())?;
        triangles += geometry.indices.len() / 3;
        geometries_by_id.insert(geometry.id.as_str(), geometry);
    }
    if geometry_bytes > MAX_GEOMETRY_BYTES {
        return Err("geometry data exceeds the 128 MiB packet budget".into());
    }

    Ok((geometries_by_id, triangles))
}

pub(super) fn validate_material_geometry(
    source: &GeometryResource,
    material: MaterialFeatures,
    material_id: &str,
) -> Result<(), String> {
    let geometry = GeometryFeatures::from_geometry(source);
    if material.requires_uv0 && !geometry.uv0 {
        return Err(format!(
            "geometry {} requires UV0 for textured material {material_id}",
            source.id
        ));
    }
    if material.requires_uv1 && !geometry.uv1 {
        return Err(format!(
            "geometry {} requires UV1 for textured material {material_id}",
            source.id
        ));
    }
    if material.normal_mapped && !geometry.tangents {
        return Err(format!(
            "geometry {} requires a tangent basis for normal-mapped material {material_id}",
            source.id
        ));
    }
    Ok(())
}

fn validate_tangents(geometry: &GeometryResource, vertex_count: usize) -> Result<(), String> {
    let Some(tangents) = &geometry.tangents else {
        return Ok(());
    };
    if tangents.len() != vertex_count * 4 {
        return Err(format!(
            "geometry {} has an invalid tangent layout",
            geometry.id
        ));
    }
    for (vertex_index, tangent) in tangents.chunks_exact(4).enumerate() {
        let normal = &geometry.vertices[vertex_index * 6 + 3..vertex_index * 6 + 6];
        let length = norm(&tangent[..3]);
        let normal_length = norm(normal);
        let dot = tangent[0] * normal[0] + tangent[1] * normal[1] + tangent[2] * normal[2];
        if tangent.iter().any(|value| !value.is_finite())
            || (length - 1.0).abs() > 1e-3
            || !matches!(tangent[3], -1.0 | 1.0)
            || (dot / normal_length).abs() > 1e-3
        {
            return Err(format!(
                "geometry {} has an invalid tangent basis",
                geometry.id
            ));
        }
    }
    for triangle in geometry.indices.chunks_exact(3) {
        let sign = tangents[triangle[0] as usize * 4 + 3];
        if sign != tangents[triangle[1] as usize * 4 + 3]
            || sign != tangents[triangle[2] as usize * 4 + 3]
        {
            return Err(format!(
                "geometry {} has inconsistent triangle tangent handedness",
                geometry.id
            ));
        }
    }
    Ok(())
}

pub(super) fn norm(column: &[f32]) -> f32 {
    (column[0] * column[0] + column[1] * column[1] + column[2] * column[2]).sqrt()
}
