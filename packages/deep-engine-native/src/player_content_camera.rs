use super::PlayerContent;
use deep_engine_native::{player_view::PlayerView, runtime_camera::RuntimeCameraControls};

impl PlayerContent {
    pub fn initial_view(&self) -> PlayerView {
        let mut view = self.authored_view.unwrap_or_default();
        let delta = self.authored_to_runtime_delta();
        for (axis, value) in delta.iter().enumerate() {
            view.target[axis] += *value;
        }
        self.resolve_camera_motion(None, view.constrained(self.camera_controls()))
    }

    pub fn camera_controls(&self) -> RuntimeCameraControls {
        self.authored_camera
            .as_ref()
            .and_then(|camera| camera.controls)
            .unwrap_or_default()
    }

    pub fn camera_view(&self, index: usize) -> Option<(&str, &str, PlayerView)> {
        let camera = self.authored_camera.as_ref()?;
        let authored = camera.camera_views.as_ref()?.get(index)?;
        let mut view = PlayerView::from_camera(camera)
            .ok()?
            .with_eye_target(
                authored.position.map(|value| value as f32),
                authored.target.map(|value| value as f32),
            )
            .ok()?
            .constrained(self.camera_controls());
        let delta = self.authored_to_runtime_delta();
        for (axis, value) in delta.iter().enumerate() {
            view.target[axis] += *value;
        }
        Some((
            &authored.id,
            &authored.name,
            self.resolve_camera_motion(None, view),
        ))
    }

    pub fn camera_view_count(&self) -> usize {
        self.authored_camera
            .as_ref()
            .and_then(|camera| camera.camera_views.as_ref())
            .map_or(0, Vec::len)
    }

    pub fn resolve_camera_motion(
        &self,
        previous: Option<PlayerView>,
        desired: PlayerView,
    ) -> PlayerView {
        let controls = self.camera_controls();
        if !controls.collision_enabled {
            return desired;
        }
        crate::player_picking::resolve_camera_collision(
            &self.packet,
            previous,
            desired,
            controls.collision_radius as f32,
            [controls.min_distance as f32, controls.max_distance as f32],
        )
    }

    pub fn view_after_reload(&self, previous: &Self, current: PlayerView) -> PlayerView {
        let candidate = if self.coordinate_frame == previous.coordinate_frame {
            if self.authored_view == previous.authored_view {
                current
            } else {
                self.initial_view()
            }
            .constrained(self.camera_controls())
        } else if !self.same_authored_world_camera(previous) || current.clipping != [0.0; 4] {
            self.initial_view()
        } else {
            // Preserve orbit orientation/distance, moving only its local anchor between frames.
            let translated = previous
                .local_to_world(current.target.map(f64::from))
                .and_then(|world| self.world_to_local(world));
            match translated {
                Ok(target) => PlayerView {
                    target: target.map(|value| value as f32),
                    ..current
                }
                .constrained(self.camera_controls()),
                Err(_) => self.initial_view(),
            }
        };
        // The new packet may place an obstacle on an otherwise unchanged
        // authored camera, so reload validates the complete target-to-eye line.
        self.resolve_camera_motion(None, candidate)
    }

    fn same_authored_world_camera(&self, previous: &Self) -> bool {
        let (Some(next), Some(old)) = (&self.authored_camera, &previous.authored_camera) else {
            return false;
        };
        if next.vertical_fov_degrees != old.vertical_fov_degrees
            || next.near != old.near
            || next.far != old.far
        {
            return false;
        }
        for (next_local, old_local) in [(next.position, old.position), (next.target, old.target)] {
            let next_world: [f64; 3] =
                std::array::from_fn(|i| next_local[i] + self.authored_coordinate_origin[i]);
            let old_world: [f64; 3] =
                std::array::from_fn(|i| old_local[i] + previous.authored_coordinate_origin[i]);
            if (0..3).any(|i| {
                (next_world[i] - old_world[i]).abs()
                    > deep_engine_native::runtime_coordinates::MAX_ROUND_TRIP_ERROR
            }) {
                return false;
            }
        }
        true
    }
}
