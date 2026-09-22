#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayerView {
    pub yaw: f32,
    pub pitch: f32,
    pub focal: f32,
    pub near: f32,
    pub far: f32,
    pub target: [f32; 3],
    pub distance: f32,
    pub clipping: [f32; 4],
}

impl Default for PlayerView {
    fn default() -> Self {
        Self {
            yaw: 0.55,
            pitch: 0.0,
            focal: crate::mesh_abi::CAMERA_FOCAL,
            near: crate::mesh_abi::CAMERA_NEAR,
            far: crate::mesh_abi::CAMERA_FAR,
            target: [0.0; 3],
            distance: 4.0,
            clipping: [0.0; 4],
        }
    }
}

impl PlayerView {
    /// Translate both the orbit anchor and eye together. This is the common
    /// camera operation for first/third-person locomotion and preserves the
    /// authored yaw, pitch and distance.
    pub fn translate(mut self, delta: [f32; 3]) -> Self {
        if delta.iter().all(|value| value.is_finite()) {
            for (axis, value) in delta.iter().enumerate() {
                self.target[axis] += *value;
            }
        }
        self
    }

    pub fn constrained(mut self, controls: crate::runtime_camera::RuntimeCameraControls) -> Self {
        let min_pitch =
            std::f32::consts::FRAC_PI_2 - (controls.max_polar_angle_degrees as f32).to_radians();
        let max_pitch =
            std::f32::consts::FRAC_PI_2 - (controls.min_polar_angle_degrees as f32).to_radians();
        self.pitch = self.pitch.clamp(min_pitch, max_pitch);
        self.distance = self
            .distance
            .clamp(controls.min_distance as f32, controls.max_distance as f32);
        self
    }

    pub fn with_eye_target(self, position: [f32; 3], target: [f32; 3]) -> Result<Self, String> {
        let delta: [f32; 3] = std::array::from_fn(|index| position[index] - target[index]);
        let horizontal = delta[0].hypot(delta[2]);
        let distance = horizontal.hypot(delta[1]);
        if !distance.is_finite()
            || distance <= f32::EPSILON
            || position
                .iter()
                .chain(target.iter())
                .any(|value| !value.is_finite())
        {
            return Err("dynamic camera position and target must be finite and distinct".into());
        }
        Ok(Self {
            yaw: (-delta[0]).atan2(delta[2]),
            pitch: delta[1].atan2(horizontal),
            target,
            distance,
            ..self
        })
    }

    pub fn from_camera(camera: &crate::runtime_camera::RuntimeSceneCamera) -> Result<Self, String> {
        let controls = camera.native_controls()?;
        let target = camera.target.map(|v| v as f32);
        let delta: [f64; 3] =
            std::array::from_fn(|i| camera.position[i] as f32 as f64 - target[i] as f64);
        let horizontal = delta[0].hypot(delta[2]);
        Ok(Self {
            yaw: (-delta[0]).atan2(delta[2]) as f32,
            pitch: delta[1].atan2(horizontal) as f32,
            target,
            distance: horizontal.hypot(delta[1]) as f32,
            focal: (1.0 / (camera.vertical_fov_degrees.to_radians() * 0.5).tan()) as f32,
            near: camera.near as f32,
            far: camera.far as f32,
            clipping: camera
                .clipping_plane
                .map(|plane| plane.map(|v| v as f32))
                .unwrap_or([0.0; 4]),
        }
        .constrained(controls))
    }

    pub fn basis(self) -> [[f32; 3]; 3] {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        [
            [cy, 0.0, sy],
            [sy * sp, cp, -cy * sp],
            [sy * cp, -sp, -cy * cp],
        ]
    }

    pub fn eye(self) -> [f32; 3] {
        let forward = self.basis()[2];
        std::array::from_fn(|i| self.target[i] - self.distance * forward[i])
    }
}
