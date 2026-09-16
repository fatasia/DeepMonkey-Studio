use std::collections::HashMap;

use super::{
    GeometryResource, RenderInstance, RenderLodLevel, RenderLodProfile, uv_sets::MaterialFeatures,
    validate_geometry::validate_material_geometry,
};

pub const DEFAULT_LOD_HYSTERESIS_RATIO: f64 = 0.12;

impl RenderLodProfile {
    pub fn hysteresis_ratio(&self) -> f64 {
        self.hysteresis_ratio
            .unwrap_or(DEFAULT_LOD_HYSTERESIS_RATIO)
    }
}

impl RenderLodLevel {
    pub fn is_resident(&self) -> bool {
        self.resident.unwrap_or(true)
    }
}

pub(super) fn validate_lod(
    instance: &RenderInstance,
    geometries: &HashMap<&str, &GeometryResource>,
    material: MaterialFeatures,
) -> Result<(), String> {
    let Some(profile) = &instance.lod else {
        return Ok(());
    };
    let label = format!("LOD profile for instance {}", instance.id);
    if profile.author.is_some() {
        super::author_lod::validate(profile)?;
        if profile.levels[0].geometry != instance.geometry {
            return Err(format!("{label} must start with its primary geometry"));
        }
        for level in &profile.levels {
            let geometry = geometries
                .get(level.geometry.as_str())
                .ok_or_else(|| format!("{label} missing geometry"))?;
            if geometry.indices.len() < 3 {
                return Err(format!("{label} requires triangles"));
            }
            validate_material_geometry(geometry, material, &instance.material)?;
        }
        return Ok(());
    }
    if !(2..=8).contains(&profile.levels.len()) {
        return Err(format!("{label} must have 2-8 levels"));
    }
    if profile.levels[0].geometry != instance.geometry {
        return Err(format!("{label} must start with its primary geometry"));
    }
    let hysteresis = profile.hysteresis_ratio();
    if !hysteresis.is_finite() || !(0.0..=0.49).contains(&hysteresis) {
        return Err(format!(
            "{label} hysteresis ratio must be between 0 and 0.49"
        ));
    }
    let mut previous: Option<(&RenderLodLevel, usize)> = None;
    for (index, level) in profile.levels.iter().enumerate() {
        let geometry = geometries
            .get(level.geometry.as_str())
            .ok_or_else(|| format!("{label} has missing LOD geometry at level {index}"))?;
        let triangles = geometry.indices.len() / 3;
        if triangles == 0 {
            return Err(format!(
                "{label} geometry {} requires triangles",
                level.geometry
            ));
        }
        if !level.min_projected_diameter_pixels.is_finite()
            || !(0.0..=1e9).contains(&level.min_projected_diameter_pixels)
        {
            return Err(format!(
                "{label} has invalid LOD threshold at level {index}"
            ));
        }
        if !level.geometric_error.is_finite() || !(0.0..=1e15).contains(&level.geometric_error) {
            return Err(format!(
                "{label} has invalid LOD geometric error at level {index}"
            ));
        }
        validate_material_geometry(geometry, material, &instance.material)?;
        if let Some((finer, finer_triangles)) = previous {
            if finer.min_projected_diameter_pixels <= level.min_projected_diameter_pixels {
                return Err(format!("{label} thresholds must strictly decrease"));
            }
            if finer.min_projected_diameter_pixels as f32
                <= level.min_projected_diameter_pixels as f32
            {
                return Err(format!(
                    "{label} thresholds must strictly decrease after float32 conversion"
                ));
            }
            if finer_triangles <= triangles {
                return Err(format!("{label} triangle counts must strictly decrease"));
            }
            if finer.geometric_error > level.geometric_error {
                return Err(format!("{label} geometric errors must not decrease"));
            }
        }
        previous = Some((level, triangles));
    }
    let coarsest = profile.levels.last().expect("validated LOD level count");
    if coarsest.min_projected_diameter_pixels != 0.0 {
        return Err(format!("{label} coarsest LOD threshold must be zero"));
    }
    if !profile.levels[0].is_resident() {
        return Err(format!("{label} primary LOD geometry must be resident"));
    }
    if !coarsest.is_resident() {
        return Err(format!(
            "{label} coarsest LOD geometry must be resident for fallback"
        ));
    }
    Ok(())
}
