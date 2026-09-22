//! Deterministic first/third-person navigation math.
//!
//! This module deliberately owns no window or renderer state.  It is the
//! step used by a future event-loop input adapter. Web parity still requires
//! input replay and collision integration. Native publication remains fail-closed until that adapter
//! supplies a real frame clock and collision world.

use crate::{player_view::PlayerView, runtime_camera::RuntimeCameraControls};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavigationInput {
    /// Forward/backward axis. Positive is forward.
    pub forward: f32,
    /// Right/left axis. Positive is right.
    pub strafe: f32,
    /// Vertical axis used by fly mode. Positive is up.
    pub vertical: f32,
    pub sprint: bool,
    pub jump: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavigationState {
    pub vertical_velocity: f32,
    pub grounded: bool,
    /// The first eye height is the authored floor reference. A real collision
    /// adapter replaces this reference with the resolved triangle height.
    pub(crate) ground_height: Option<f32>,
}

impl NavigationState {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Advance one bounded frame. `dt_seconds` is clamped so a stalled window
    /// cannot turn a single input event into a teleport.
    pub fn step(
        &mut self,
        view: PlayerView,
        controls: RuntimeCameraControls,
        input: NavigationInput,
        dt_seconds: f32,
    ) -> PlayerView {
        if !matches!(
            controls.mode,
            crate::runtime_camera::RuntimeCameraMode::FirstPerson
                | crate::runtime_camera::RuntimeCameraMode::ThirdPerson
        ) {
            return view;
        }
        let dt = if dt_seconds.is_finite() {
            dt_seconds.clamp(0.0, 0.1)
        } else {
            0.0
        };
        // 暂停或无效时钟不能消耗跳跃，也不能初始化地面状态。
        if dt == 0.0 {
            return view;
        }
        let mut forward = input.forward.clamp(-1.0, 1.0);
        let mut strafe = input.strafe.clamp(-1.0, 1.0);
        let length = forward.hypot(strafe);
        if length > 1.0 {
            forward /= length;
            strafe /= length;
        }
        let speed = if matches!(
            controls.mode,
            crate::runtime_camera::RuntimeCameraMode::FirstPerson
        ) {
            controls.walk_speed
        } else {
            controls.fly_speed
        } as f32
            * if input.sprint {
                controls.sprint_multiplier as f32
            } else {
                1.0
            };
        let (sy, cy) = view.yaw.sin_cos();
        // eye = target - distance * basis[2]，因此向前必须沿 basis[2]。
        let dx = (sy * forward + cy * strafe) * speed * dt;
        let dz = (-cy * forward + sy * strafe) * speed * dt;
        let mut delta = [dx, 0.0, dz];

        if controls.fly_speed > 0.0 && controls.gravity == 0.0 {
            delta[1] = input.vertical.clamp(-1.0, 1.0) * controls.fly_speed as f32 * dt;
            self.grounded = false;
            self.vertical_velocity = 0.0;
        } else if controls.gravity > 0.0 {
            let eye_y = view.eye()[1];
            let ground = *self
                .ground_height
                .get_or_insert(eye_y - controls.eye_height as f32);
            if self.grounded && input.jump {
                self.vertical_velocity = controls.jump_speed as f32;
                self.grounded = false;
            }
            self.vertical_velocity -= controls.gravity as f32 * dt;
            delta[1] = self.vertical_velocity * dt;
            let next_eye_y = eye_y + delta[1];
            let floor_eye = ground + controls.eye_height as f32;
            if next_eye_y <= floor_eye {
                delta[1] = floor_eye - eye_y;
                self.vertical_velocity = 0.0;
                self.grounded = true;
            }
        }
        view.translate(delta)
    }
}
