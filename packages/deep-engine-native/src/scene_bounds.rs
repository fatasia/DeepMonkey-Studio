use std::collections::{HashMap, HashSet};

use crate::contract::{GeometryResource, RenderPacket};

pub const MAX_SCENE_COORDINATE: f32 = 1_000_000.0;
pub const MAX_SCENE_SPAN: f32 = 100_000.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SceneWorldBounds {
    pub minimum: [f32; 3],
    pub maximum: [f32; 3],
}

impl SceneWorldBounds {
    pub fn validate(self) -> Result<Self, String> {
        for axis in 0..3 {
            let (minimum, maximum) = (self.minimum[axis], self.maximum[axis]);
            if !minimum.is_finite()
                || !maximum.is_finite()
                || minimum > maximum
                || minimum.abs() > MAX_SCENE_COORDINATE
                || maximum.abs() > MAX_SCENE_COORDINATE
                || maximum - minimum > MAX_SCENE_SPAN
            {
                return Err("scene world bounds exceed the native shadow fitting range".into());
            }
        }
        Ok(self)
    }

    pub fn corners(self) -> [[f32; 3]; 8] {
        let mut corners = [[0.0; 3]; 8];
        let mut index = 0;
        for z in [self.minimum[2], self.maximum[2]] {
            for y in [self.minimum[1], self.maximum[1]] {
                for x in [self.minimum[0], self.maximum[0]] {
                    corners[index] = [x, y, z];
                    index += 1;
                }
            }
        }
        corners
    }

    pub fn projected_range(self, origin: [f32; 3], axis: [f32; 3]) -> (f32, f32) {
        self.corners()
            .into_iter()
            .map(|corner| dot(sub(corner, origin), axis))
            .fold((f32::INFINITY, f32::NEG_INFINITY), |range, value| {
                (range.0.min(value), range.1.max(value))
            })
    }
}

pub fn prepare_scene_bounds(packet: &RenderPacket) -> Result<Option<SceneWorldBounds>, String> {
    if packet.instances.is_empty() {
        return Ok(None);
    }
    let mut used = HashSet::new();
    for instance in &packet.instances {
        used.insert(instance.geometry.as_str());
        if let Some(profile) = &instance.lod {
            used.extend(profile.levels.iter().map(|level| level.geometry.as_str()));
        }
    }
    let geometries: HashMap<_, _> = packet
        .geometries
        .iter()
        .filter(|geometry| used.contains(geometry.id.as_str()))
        .map(|geometry| local_bounds(geometry).map(|bounds| (geometry.id.as_str(), bounds)))
        .collect::<Result<HashMap<_, _>, String>>()?;
    let mut world = Accumulator::default();
    for instance in &packet.instances {
        let primary = geometries
            .get(instance.geometry.as_str())
            .ok_or_else(|| format!("scene bounds missing geometry {}", instance.geometry))?;
        world.include(transform_bounds(*primary, &instance.transform)?);
        if let Some(profile) = &instance.lod {
            for level in &profile.levels {
                let bounds = geometries.get(level.geometry.as_str()).ok_or_else(|| {
                    format!("scene bounds missing LOD geometry {}", level.geometry)
                })?;
                world.include(transform_bounds(*bounds, &instance.transform)?);
            }
        }
    }
    world.finish()
}

fn local_bounds(geometry: &GeometryResource) -> Result<SceneWorldBounds, String> {
    let mut bounds = Accumulator::default();
    for &index in &geometry.indices {
        let offset = usize::try_from(index)
            .ok()
            .and_then(|index| index.checked_mul(6))
            .ok_or_else(|| format!("geometry {} bounds index overflows usize", geometry.id))?;
        let position = geometry
            .vertices
            .get(offset..offset + 3)
            .ok_or_else(|| format!("geometry {} bounds index is out of range", geometry.id))?;
        if position.iter().any(|value| !value.is_finite()) {
            return Err(format!(
                "geometry {} has a non-finite indexed position",
                geometry.id
            ));
        }
        bounds.include_point([position[0], position[1], position[2]]);
    }
    bounds
        .finish()?
        .ok_or_else(|| format!("geometry {} has no indexed bounds", geometry.id))
}

fn transform_bounds(
    local: SceneWorldBounds,
    transform: &[f32; 16],
) -> Result<SceneWorldBounds, String> {
    if transform.iter().any(|value| !value.is_finite()) {
        return Err("scene instance transform contains a non-finite value".into());
    }
    if transform[3] != 0.0 || transform[7] != 0.0 || transform[11] != 0.0 || transform[15] != 1.0 {
        return Err("scene bounds require an affine instance transform".into());
    }
    let center: [f64; 3] = std::array::from_fn(|axis| {
        (f64::from(local.minimum[axis]) + f64::from(local.maximum[axis])) * 0.5
    });
    let extent: [f64; 3] = std::array::from_fn(|axis| {
        (f64::from(local.maximum[axis]) - f64::from(local.minimum[axis])) * 0.5
    });
    let mut minimum = [0.0; 3];
    let mut maximum = [0.0; 3];
    for row in 0..3 {
        let world_center = f64::from(transform[12 + row])
            + (0..3)
                .map(|column| f64::from(transform[column * 4 + row]) * center[column])
                .sum::<f64>();
        let world_extent = (0..3)
            .map(|column| f64::from(transform[column * 4 + row]).abs() * extent[column])
            .sum::<f64>();
        let values = [world_center - world_extent, world_center + world_extent];
        if values
            .iter()
            .any(|value| !value.is_finite() || value.abs() > f64::from(MAX_SCENE_COORDINATE))
        {
            return Err("scene world bounds exceed the native floating-origin range".into());
        }
        minimum[row] = values[0] as f32;
        maximum[row] = values[1] as f32;
    }
    Ok(SceneWorldBounds { minimum, maximum })
}

struct Accumulator {
    minimum: [f32; 3],
    maximum: [f32; 3],
}

impl Default for Accumulator {
    fn default() -> Self {
        Self {
            minimum: [f32::INFINITY; 3],
            maximum: [f32::NEG_INFINITY; 3],
        }
    }
}

impl Accumulator {
    fn include_point(&mut self, point: [f32; 3]) {
        for (axis, value) in point.into_iter().enumerate() {
            self.minimum[axis] = self.minimum[axis].min(value);
            self.maximum[axis] = self.maximum[axis].max(value);
        }
    }

    fn include(&mut self, bounds: SceneWorldBounds) {
        self.include_point(bounds.minimum);
        self.include_point(bounds.maximum);
    }

    fn finish(self) -> Result<Option<SceneWorldBounds>, String> {
        if self.minimum[0] == f32::INFINITY {
            return Ok(None);
        }
        for axis in 0..3 {
            let span = self.maximum[axis] - self.minimum[axis];
            if !span.is_finite() || span > MAX_SCENE_SPAN {
                return Err("scene world bounds exceed the native shadow fitting span".into());
            }
        }
        SceneWorldBounds {
            minimum: self.minimum,
            maximum: self.maximum,
        }
        .validate()
        .map(Some)
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
