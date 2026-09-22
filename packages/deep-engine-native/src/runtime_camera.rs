use crate::runtime_coordinates::SceneLocalCoordinateFrame;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeCameraMode {
    Orbit,
    FirstPerson,
    ThirdPerson,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCameraControls {
    pub mode: RuntimeCameraMode,
    pub min_distance: f64,
    pub max_distance: f64,
    pub min_polar_angle_degrees: f64,
    pub max_polar_angle_degrees: f64,
    pub collision_enabled: bool,
    pub collision_radius: f64,
    pub walk_speed: f64,
    pub fly_speed: f64,
    pub sprint_multiplier: f64,
    pub eye_height: f64,
    pub gravity: f64,
    pub jump_speed: f64,
    pub step_height: f64,
    pub max_slope_angle_degrees: f64,
}

impl Default for RuntimeCameraControls {
    fn default() -> Self {
        Self {
            mode: RuntimeCameraMode::Orbit,
            min_distance: 0.01,
            max_distance: 10_000_000.0,
            min_polar_angle_degrees: 0.0,
            max_polar_angle_degrees: 180.0,
            collision_enabled: false,
            collision_radius: 0.02,
            walk_speed: 1.0,
            fly_speed: 1.0,
            sprint_multiplier: 1.0,
            eye_height: 1.7,
            gravity: 0.0,
            jump_speed: 0.0,
            step_height: 0.0,
            max_slope_angle_degrees: 0.0,
        }
    }
}

impl RuntimeCameraControls {
    fn validate(&self) -> Result<(), String> {
        let bounded =
            |value: f64, min: f64, max: f64| value.is_finite() && (min..=max).contains(&value);
        if !bounded(self.min_distance, 0.01, 10_000_000.0)
            || !bounded(self.max_distance, 0.02, 10_000_000.0)
            || self.max_distance <= self.min_distance
            || !bounded(self.min_polar_angle_degrees, 0.0, 179.0)
            || !bounded(self.max_polar_angle_degrees, 0.1, 180.0)
            || self.max_polar_angle_degrees <= self.min_polar_angle_degrees
            || !bounded(self.collision_radius, 0.02, 10_000.0)
            || !bounded(self.walk_speed, 0.1, 50.0)
            || !bounded(self.fly_speed, 0.1, 100.0)
            || !bounded(self.sprint_multiplier, 1.0, 6.0)
            || !bounded(self.eye_height, 0.3, 4.0)
            || !bounded(self.gravity, 0.0, 80.0)
            || !bounded(self.jump_speed, 0.0, 30.0)
            || !bounded(self.step_height, 0.0, 1.2)
            || !bounded(self.max_slope_angle_degrees, 0.0, 89.0)
        {
            return Err("invalid scene camera controls".into());
        }
        Ok(())
    }

    pub fn validate_native_support(&self) -> Result<(), String> {
        match self.mode {
            RuntimeCameraMode::Orbit => {}
            RuntimeCameraMode::FirstPerson => {
                // Native currently consumes deterministic locomotion, gravity,
                // jump and the existing triangle sweep.  It does not yet have
                // the Web character controller's floor probe/step-up/slope
                // solver, so accepting those fields would publish a subtly
                // different walkable world.
                if self.step_height > 0.0 || self.max_slope_angle_degrees > 0.0 {
                    return Err(
                        "native firstPerson navigation requires stepHeight=0 and maxSlopeAngleDegrees=0".into(),
                    );
                }
            }
            RuntimeCameraMode::ThirdPerson => {
                if self.step_height > 0.0 || self.max_slope_angle_degrees > 0.0 {
                    return Err(
                        "native thirdPerson navigation requires stepHeight=0 and maxSlopeAngleDegrees=0".into(),
                    );
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCameraView {
    pub id: String,
    pub name: String,
    pub position: [f64; 3],
    pub target: [f64; 3],
}

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
    #[serde(default, deserialize_with = "deserialize_clipping_plane")]
    pub clipping_plane: Option<[f64; 4]>,
    #[serde(default, deserialize_with = "deserialize_controls")]
    pub controls: Option<RuntimeCameraControls>,
    #[serde(default, deserialize_with = "deserialize_camera_views")]
    pub camera_views: Option<Vec<RuntimeCameraView>>,
    #[serde(default, deserialize_with = "deserialize_default_camera_view_id")]
    pub default_camera_view_id: Option<String>,
}

fn deserialize_frame<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<SceneLocalCoordinateFrame>, D::Error> {
    // Missing is allowed for v1; an explicitly supplied null is not a frame.
    SceneLocalCoordinateFrame::deserialize(deserializer).map(Some)
}

fn deserialize_clipping_plane<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<[f64; 4]>, D::Error> {
    <[f64; 4]>::deserialize(deserializer).map(Some)
}

fn deserialize_controls<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RuntimeCameraControls>, D::Error> {
    RuntimeCameraControls::deserialize(deserializer).map(Some)
}

fn deserialize_camera_views<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<RuntimeCameraView>>, D::Error> {
    Vec::<RuntimeCameraView>::deserialize(deserializer).map(Some)
}

fn deserialize_default_camera_view_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

impl RuntimeSceneCamera {
    pub fn native_controls(&self) -> Result<RuntimeCameraControls, String> {
        self.validate()?;
        let controls = self.controls.unwrap_or_default();
        controls.validate_native_support()?;
        Ok(controls)
    }

    pub fn validate(&self) -> Result<(), String> {
        let id = self.id.as_bytes();
        if self.schema != "deep-engine.scene-camera"
            || !matches!(self.schema_version, 1..=5)
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
        if self.clipping_plane.is_some() && !matches!(self.schema_version, 3..=5) {
            return Err("scene camera clipping plane requires schema version 3, 4 or 5".into());
        }
        match (self.schema_version, self.controls) {
            (4 | 5, Some(controls)) => controls.validate()?,
            (4 | 5, None) => return Err("scene camera v4/v5 requires controls".into()),
            (_, Some(_)) => {
                return Err("scene camera controls require schema version 4 or 5".into());
            }
            _ => {}
        }
        match (
            self.schema_version,
            &self.camera_views,
            &self.default_camera_view_id,
        ) {
            (5, Some(views), Some(default_id)) => {
                if views.is_empty() || views.len() > 32 {
                    return Err("scene camera v5 requires 1..32 saved views".into());
                }
                let mut ids = std::collections::HashSet::new();
                for view in views {
                    if view.id.is_empty()
                        || view.id.len() > 256
                        || !ids.insert(view.id.as_str())
                        || view.name.trim().is_empty()
                        || view.name.len() > 128
                        || view
                            .position
                            .iter()
                            .chain(&view.target)
                            .any(|value| !value.is_finite() || value.abs() > 10_000_000.0)
                    {
                        return Err("invalid saved camera view".into());
                    }
                    let distance = (0..3)
                        .map(|axis| {
                            (view.position[axis] as f32 as f64 - view.target[axis] as f32 as f64)
                                .powi(2)
                        })
                        .sum::<f64>()
                        .sqrt();
                    if distance < 0.0001 {
                        return Err(
                            "saved camera position and target must remain distinct in float32"
                                .into(),
                        );
                    }
                }
                if !ids.contains(default_id.as_str()) {
                    return Err("default camera view is missing".into());
                }
            }
            (5, _, _) => return Err("scene camera v5 requires saved views and a default id".into()),
            (_, None, None) => {}
            _ => return Err("saved camera views require schema version 5".into()),
        }
        match (self.schema_version, &self.coordinate_frame) {
            (1, None) => {}
            (2..=5, Some(frame)) => {
                frame.validate()?;
                frame.local_to_world(self.position)?;
                frame.local_to_world(self.target)?;
            }
            (2, None) => return Err("scene camera v2 requires the coordinate frame".into()),
            (3..=5, None) => {}
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
            if plane
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 10_000_000.0)
            {
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

    fn controls() -> Value {
        json!({"mode":"orbit","minDistance":1,"maxDistance":20,
            "minPolarAngleDegrees":10,"maxPolarAngleDegrees":150,
            "collisionEnabled":false,"collisionRadius":0.25,
            "walkSpeed":2,"flySpeed":8,"sprintMultiplier":2,"eyeHeight":1.7,
            "gravity":9.81,"jumpSpeed":4,"stepHeight":0.3,"maxSlopeAngleDegrees":45})
    }

    fn camera_v4() -> Value {
        let mut value = camera();
        value["schemaVersion"] = json!(4);
        value.as_object_mut().unwrap().remove("coordinateFrame");
        value["controls"] = controls();
        value
    }

    fn camera_v5() -> Value {
        let mut value = camera_v4();
        value["schemaVersion"] = json!(5);
        value["cameraViews"] = json!([
            {"id":"overview","name":"Overview","position":[1,2,5],"target":[0,0,0]},
            {"id":"detail","name":"Detail","position":[3,2,1],"target":[1,0,0]}
        ]);
        value["defaultCameraViewId"] = json!("overview");
        value
    }

    #[test]
    fn schema_four_strictly_requires_and_validates_controls() {
        assert!(valid(camera_v4()));
        let mut missing = camera_v4();
        missing.as_object_mut().unwrap().remove("controls");
        assert!(!valid(missing));
        let mut null = camera_v4();
        null["controls"] = Value::Null;
        assert!(!valid(null));
        let mut unknown = camera_v4();
        unknown["controls"]["future"] = json!(true);
        assert!(!valid(unknown));
        for (field, invalid) in [
            ("minDistance", json!(0.0)),
            ("maxDistance", json!(1.0)),
            ("minPolarAngleDegrees", json!(150.0)),
            ("collisionRadius", json!(0.0)),
            ("walkSpeed", json!(50.1)),
            ("flySpeed", json!(100.1)),
            ("sprintMultiplier", json!(0.9)),
            ("eyeHeight", json!(4.1)),
            ("gravity", json!(-1)),
            ("jumpSpeed", json!(31)),
            ("stepHeight", json!(1.3)),
            ("maxSlopeAngleDegrees", json!(90)),
        ] {
            let mut value = camera_v4();
            value["controls"][field] = invalid;
            assert!(!valid(value), "accepted invalid {field}");
        }
        let mut legacy = camera();
        legacy["controls"] = controls();
        assert!(!valid(legacy));
        let mut legacy_null = camera();
        legacy_null["controls"] = Value::Null;
        assert!(!valid(legacy_null));
    }

    #[test]
    fn native_support_consumes_simple_locomotion_and_blocks_unimplemented_ground_solver() {
        let orbit: RuntimeSceneCamera = serde_json::from_value(camera_v4()).unwrap();
        assert!(orbit.native_controls().is_ok());
        for mode in ["firstPerson", "thirdPerson"] {
            let mut value = camera_v4();
            value["controls"]["mode"] = json!(mode);
            value["controls"]["stepHeight"] = json!(0.0);
            value["controls"]["maxSlopeAngleDegrees"] = json!(0.0);
            let camera: RuntimeSceneCamera = serde_json::from_value(value).unwrap();
            assert!(camera.native_controls().is_ok());
        }
        for (mode, expected) in [
            (
                "firstPerson",
                "native firstPerson navigation requires stepHeight=0 and maxSlopeAngleDegrees=0",
            ),
            (
                "thirdPerson",
                "native thirdPerson navigation requires stepHeight=0 and maxSlopeAngleDegrees=0",
            ),
        ] {
            let mut value = camera_v4();
            value["controls"]["mode"] = json!(mode);
            value["controls"]["stepHeight"] = json!(0.3);
            let camera: RuntimeSceneCamera = serde_json::from_value(value).unwrap();
            assert_eq!(camera.native_controls().unwrap_err(), expected);
        }
        let mut value = camera_v4();
        value["controls"]["collisionEnabled"] = json!(true);
        value["controls"]["mode"] = json!("firstPerson");
        value["controls"]["stepHeight"] = json!(0.0);
        value["controls"]["maxSlopeAngleDegrees"] = json!(0.0);
        let camera: RuntimeSceneCamera = serde_json::from_value(value).unwrap();
        assert!(camera.native_controls().is_ok());
    }

    #[test]
    fn schema_five_requires_bounded_unique_views_and_a_real_default() {
        assert!(valid(camera_v5()));
        for mutate in [
            |value: &mut Value| value["cameraViews"] = json!([]),
            |value: &mut Value| value["defaultCameraViewId"] = json!("missing"),
            |value: &mut Value| value["cameraViews"][1]["id"] = json!("overview"),
            |value: &mut Value| value["cameraViews"][1]["target"] = json!([3, 2, 1]),
        ] {
            let mut value = camera_v5();
            mutate(&mut value);
            assert!(!valid(value));
        }
        let mut legacy = camera_v4();
        legacy["cameraViews"] = camera_v5()["cameraViews"].clone();
        legacy["defaultCameraViewId"] = json!("overview");
        assert!(!valid(legacy));
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
