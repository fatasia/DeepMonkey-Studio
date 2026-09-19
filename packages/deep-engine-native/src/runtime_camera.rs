use crate::runtime_coordinates::SceneLocalCoordinateFrame;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSceneCamera {
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub position: [f64; 3],
    pub target: [f64; 3],
    pub vertical_fov_degrees: f64,
    pub near: f64,
    pub far: f64,
    #[serde(default, deserialize_with = "deserialize_frame")]
    pub coordinate_frame: Option<SceneLocalCoordinateFrame>,
    #[serde(default)]
    pub clipping_plane: Option<[f64; 4]>,
}

fn deserialize_frame<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<SceneLocalCoordinateFrame>, D::Error> {
    // Missing is allowed for v1; an explicitly supplied null is not a frame.
    SceneLocalCoordinateFrame::deserialize(deserializer).map(Some)
}

impl RuntimeSceneCamera {
    pub fn validate(&self) -> Result<(), String> {
        let id = self.id.as_bytes();
        if self.schema != "deep-engine.scene-camera"
            || !matches!(self.schema_version, 1 | 2 | 3)
            || id.is_empty()
            || id.len() > 256
            || !id[0].is_ascii_lowercase() && !id[0].is_ascii_digit()
            || !id
                .iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._:/-".contains(c))
            || self.revision == 0
            || self.revision > 9_007_199_254_740_991
        {
            return Err("invalid scene camera identity".into());
        }
        if self.clipping_plane.is_some() && self.schema_version != 3 {
            return Err("scene camera clipping plane requires schema version 3".into());
        }
        match (self.schema_version, &self.coordinate_frame) {
            (1, None) => {}
            (2 | 3, Some(frame)) => {
                frame.validate()?;
                frame.local_to_world(self.position)?;
                frame.local_to_world(self.target)?;
            }
            (2, None) => return Err("scene camera v2 requires the coordinate frame".into()),
            (3, None) => {}
            _ => return Err("scene camera coordinate frame does not match schema version".into()),
        }
        if self
            .position
            .iter()
            .chain(&self.target)
            .any(|v| !v.is_finite() || v.abs() > 10_000_000.0)
            || !self.vertical_fov_degrees.is_finite()
            || !(1.0..=179.0).contains(&self.vertical_fov_degrees)
            || !self.near.is_finite()
            || !(0.0001..=10_000.0).contains(&self.near)
            || !self.far.is_finite()
            || !(0.0001..=10_000_000.0).contains(&self.far)
            || self.far as f32 <= self.near as f32
            || self.far / self.near > 10_000_000.0
        {
            return Err("invalid scene camera numbers".into());
        }
        let distance = (0..3)
            .map(|i| (self.position[i] as f32 as f64 - self.target[i] as f32 as f64).powi(2))
            .sum::<f64>()
            .sqrt();
        if distance < 0.0001 {
            return Err("camera position and target must remain distinct in float32".into());
        }
        if let Some(plane) = &self.clipping_plane {
            if plane.iter().any(|v| !v.is_finite() || v.abs() > 10_000_000.0) {
                return Err("invalid section plane numbers".into());
            }
            let length = (plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]).sqrt();
            if !((length as f32) > 0.0001 && (length as f32) <= 10_000_000.0) {
                return Err("section plane normal must stay nonzero in float32".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn camera() -> Value {
        json!({"schema":"deep-engine.scene-camera","schemaVersion":2,"id":"scene.camera","revision":1,
            "position":[1,2,5],"target":[0,0,0],"verticalFovDegrees":50,"near":0.1,"far":10000,
            "coordinateFrame":{"schemaVersion":1,"profile":{"id":"scene-local-coordinates-v1","unit":"scene-unit",
                "originGrid":1000,"maxRoundTripError":0.000001,"maxFloat32CoordinateError":0.001},
                "origin":{"x":1000000000,"y":1000000000,"z":1000000000}}})
    }

    fn valid(value: Value) -> bool {
        serde_json::from_value::<RuntimeSceneCamera>(value)
            .is_ok_and(|camera| camera.validate().is_ok())
    }

    #[test]
    fn schema_two_requires_frame_and_schema_one_forbids_it_including_null() {
        assert!(valid(camera()));
        let mut legacy = camera();
        legacy["schemaVersion"] = json!(1);
        assert!(!valid(legacy.clone()));
        legacy.as_object_mut().unwrap().remove("coordinateFrame");
        assert!(valid(legacy.clone()));
        legacy["coordinateFrame"] = Value::Null;
        assert!(!valid(legacy));
        let mut missing = camera();
        missing.as_object_mut().unwrap().remove("coordinateFrame");
        assert!(!valid(missing));
    }

    #[test]
    fn schema_three_accepts_section_plane_and_v1_rejects_it() {
        let mut value = camera();
        value["schemaVersion"] = json!(3);
        value.as_object_mut().unwrap().remove("coordinateFrame");
        assert!(valid(value.clone()));
        value["clippingPlane"] = json!([1.0, 0.0, 0.0, -2.0]);
        assert!(valid(value.clone()));
        value["clippingPlane"] = json!([0.0, 0.0, 0.0, 1.0]);
        assert!(!valid(value.clone()));
        value["clippingPlane"] = json!([1.0, 0.0, 0.0, "x"]);
        assert!(!valid(value.clone()));
        value["clippingPlane"] = json!([1e8, 0.0, 0.0, 0.0]);
        assert!(!valid(value));
        let mut legacy = camera();
        legacy["clippingPlane"] = json!([1.0, 0.0, 0.0, -2.0]);
        assert!(!valid(legacy));
        let parsed: RuntimeSceneCamera = serde_json::from_value(
            serde_json::json!({"schema":"deep-engine.scene-camera","schemaVersion":3,"id":"scene.camera","revision":1,
                "position":[1,2,5],"target":[0,0,0],"verticalFovDegrees":50,"near":0.1,"far":10000,
                "clippingPlane":[0.0,1.0,0.0,-1.5]}),
        ).unwrap();
        assert!(parsed.validate().is_ok());
        assert_eq!(parsed.clipping_plane, Some([0.0, 1.0, 0.0, -1.5]));
    }
    #[test]
    fn rejects_unknown_frame_fields_non_grid_and_changed_profile() {
        for path in [
            "schemaVersion",
            "originGrid",
            "maxRoundTripError",
            "maxFloat32CoordinateError",
            "unit",
            "id",
            "unknown",
        ] {
            let mut value = camera();
            if path == "schemaVersion" {
                value["coordinateFrame"][path] = json!(2);
            } else {
                value["coordinateFrame"]["profile"][path] = json!("invalid");
            }
            assert!(!valid(value), "accepted {path}");
        }
        for location in ["coordinateFrame", "origin"] {
            let mut value = camera();
            if location == "coordinateFrame" {
                value[location]["extra"] = json!(0);
            } else {
                value["coordinateFrame"][location]["extra"] = json!(0);
            }
            assert!(!valid(value));
        }
        let mut value = camera();
        value["coordinateFrame"]["origin"]["x"] = json!(1000.5);
        assert!(!valid(value));
        // Division rounds away the fraction at this magnitude; use the same remainder check as TS.
        let large_non_grid = 1e19_f64 + 2048.0;
        assert_eq!((large_non_grid / 1000.0).fract(), 0.0);
        assert_eq!(large_non_grid % 1000.0, 48.0);
        let mut value = camera();
        value["coordinateFrame"]["origin"]["x"] = json!(large_non_grid);
        value["position"] = json!([0, 2, 5]);
        assert!(!valid(value));
        let mut direct: RuntimeSceneCamera = serde_json::from_value(camera()).unwrap();
        direct.coordinate_frame.as_mut().unwrap().origin.x = f64::INFINITY;
        assert!(direct.validate().is_err());
    }

    #[test]
    fn rejects_frame_roundtrip_and_actual_float32_coordinate_error() {
        let mut value = camera();
        value["position"][0] = json!(1000000.01);
        assert!(!valid(value));
        let mut value = camera();
        value["coordinateFrame"]["origin"]["x"] = json!(1e20);
        assert!(!valid(value));
        let parsed: RuntimeSceneCamera = serde_json::from_value(camera()).unwrap();
        assert_eq!(
            parsed
                .coordinate_frame
                .as_ref()
                .unwrap()
                .local_to_world(parsed.target)
                .unwrap(),
            [1e9; 3]
        );
    }
}
