use serde::Deserialize;

pub const MAX_ROUND_TRIP_ERROR: f64 = 0.000001;
pub const MAX_FLOAT32_COORDINATE_ERROR: f64 = 0.001;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneCoordinate {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneLocalCoordinateProfile {
    pub id: String,
    pub unit: String,
    pub origin_grid: f64,
    pub max_round_trip_error: f64,
    pub max_float32_coordinate_error: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneLocalCoordinateFrame {
    pub schema_version: u32,
    pub profile: SceneLocalCoordinateProfile,
    pub origin: SceneCoordinate,
}

impl SceneLocalCoordinateFrame {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || self.profile.id != "scene-local-coordinates-v1"
            || self.profile.unit != "scene-unit"
            || self.profile.origin_grid != 1000.0
            || self.profile.max_round_trip_error != MAX_ROUND_TRIP_ERROR
            || self.profile.max_float32_coordinate_error != MAX_FLOAT32_COORDINATE_ERROR
            || self
                .origin_array()
                .iter()
                .any(|v| !v.is_finite() || v % 1000.0 != 0.0)
        {
            return Err("invalid scene local coordinate frame".into());
        }
        Ok(())
    }

    pub fn origin_array(&self) -> [f64; 3] {
        [self.origin.x, self.origin.y, self.origin.z]
    }

    pub fn world_to_local(&self, world: [f64; 3]) -> Result<[f64; 3], String> {
        self.validate()?;
        world_to_local(world, self.origin_array())
    }

    pub fn local_to_world(&self, local: [f64; 3]) -> Result<[f64; 3], String> {
        self.validate()?;
        local_to_world(local, self.origin_array())
    }
}

/// All tolerances use scene units. These boundaries do not implement picking or measurement.
pub fn world_to_local(world: [f64; 3], origin: [f64; 3]) -> Result<[f64; 3], String> {
    finite(world)?;
    finite(origin)?;
    let mut result = [0.0; 3];
    for i in 0..3 {
        let local = world[i] - origin[i];
        check_local(local)?;
        check_round_trip(local + origin[i], world[i])?;
        result[i] = clean_zero(local);
    }
    Ok(result)
}

pub fn local_to_world(local: [f64; 3], origin: [f64; 3]) -> Result<[f64; 3], String> {
    finite(local)?;
    finite(origin)?;
    let mut result = [0.0; 3];
    for i in 0..3 {
        check_local(local[i])?;
        let world = local[i] + origin[i];
        if !world.is_finite() {
            return Err("scene coordinate world overflow".into());
        }
        check_round_trip(world - origin[i], local[i])?;
        result[i] = clean_zero(world);
    }
    Ok(result)
}

fn finite(value: [f64; 3]) -> Result<(), String> {
    if value.iter().any(|v| !v.is_finite()) {
        return Err("scene coordinates must be finite".into());
    }
    Ok(())
}

fn check_local(value: f64) -> Result<(), String> {
    let rounded = value as f32 as f64;
    if !value.is_finite()
        || !rounded.is_finite()
        || (rounded - value).abs() > MAX_FLOAT32_COORDINATE_ERROR
    {
        return Err("scene coordinate exceeds float32 error budget".into());
    }
    Ok(())
}

fn check_round_trip(actual: f64, expected: f64) -> Result<(), String> {
    if !actual.is_finite() || (actual - expected).abs() > MAX_ROUND_TRIP_ERROR {
        return Err("scene coordinate exceeds round-trip error budget".into());
    }
    Ok(())
}

fn clean_zero(value: f64) -> f64 {
    if value == 0.0 { 0.0 } else { value }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_offsets_round_trip_without_changing_world_position() {
        for offset in [1e6, 1e9] {
            let origin = [offset; 3];
            let world = [offset + 0.125, offset - 2.25, offset + 10.5];
            assert_eq!(world_to_local(world, origin).unwrap(), [0.125, -2.25, 10.5]);
            assert_eq!(
                local_to_world(world_to_local(world, origin).unwrap(), origin).unwrap(),
                world
            );
            let next_origin = [offset + 1000.0, offset - 1000.0, offset];
            let moved = world_to_local(world, next_origin).unwrap();
            assert_eq!(local_to_world(moved, next_origin).unwrap(), world);
        }
    }

    #[test]
    fn rejects_nonfinite_overflow_quantization_and_roundtrip_loss() {
        for value in [f64::NAN, f64::INFINITY, f64::MAX, 1_000_000.01] {
            assert!(world_to_local([value; 3], [0.0; 3]).is_err());
            assert!(local_to_world([value; 3], [0.0; 3]).is_err());
        }
        assert!(world_to_local([f64::MAX; 3], [-f64::MAX; 3]).is_err());
        assert!(local_to_world([1.0; 3], [1e20; 3]).is_err());
        assert!(world_to_local([1.0; 3], [f64::NAN; 3]).is_err());
        assert!(!world_to_local([-0.0; 3], [0.0; 3]).unwrap()[0].is_sign_negative());
    }
}
