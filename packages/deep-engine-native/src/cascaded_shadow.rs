pub const MAX_CASCADES: usize = 4;
pub const CASCADED_SHADOW_UNIFORM_VEC4S: usize = 21;
pub const CASCADED_SHADOW_UNIFORM_BYTES: u64 =
    (CASCADED_SHADOW_UNIFORM_VEC4S * size_of::<[f32; 4]>()) as u64;
pub type Matrix4 = [[f32; 4]; 4];
pub type CascadedShadowUniform = [[f32; 4]; CASCADED_SHADOW_UNIFORM_VEC4S];

#[derive(Clone, Copy, Debug)]
pub struct CascadedShadowCamera {
    pub eye: [f32; 3],
    pub target: [f32; 3],
    pub up: [f32; 3],
    pub vertical_fov_radians: f32,
    pub aspect: f32,
    pub near: f32,
    pub far: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct CascadedShadowOptions {
    pub cascade_count: usize,
    pub split_lambda: f32,
    pub max_shadow_distance: f32,
    pub shadow_map_size: u32,
    pub depth_padding: f32,
    pub blend_ratio: f32,
}

impl Default for CascadedShadowOptions {
    fn default() -> Self {
        Self {
            cascade_count: 4,
            split_lambda: 0.7,
            max_shadow_distance: 40.0,
            shadow_map_size: 2_048,
            depth_padding: 10.0,
            blend_ratio: 0.12,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CascadedShadowSlice {
    pub near: f32,
    pub far: f32,
    pub blend_start: f32,
    pub radius: f32,
    pub light_far: f32,
    pub texel_world_size: f32,
    pub view_projection: Matrix4,
    pub corners: [[f32; 3]; 8],
}

#[derive(Clone, Debug)]
pub struct CascadedShadowPlan {
    pub light_direction: [f32; 3],
    pub shadow_map_size: u32,
    pub camera_forward: [f32; 3],
    pub cascades: Vec<CascadedShadowSlice>,
}

impl CascadedShadowPlan {
    pub fn uniform(&self, depth_bias: f32) -> Result<CascadedShadowUniform, String> {
        if !depth_bias.is_finite() || !(0.0..=0.1).contains(&depth_bias) {
            return Err("cascade depth bias must be finite and in 0..0.1".into());
        }
        let mut out = [[0.0; 4]; CASCADED_SHADOW_UNIFORM_VEC4S];
        let last = self.cascades.last().ok_or("cascade plan is empty")?;
        for index in 0..MAX_CASCADES {
            let cascade = self.cascades.get(index).unwrap_or(last);
            out[index * 4..index * 4 + 4].copy_from_slice(&cascade.view_projection);
            out[16][index] = cascade.far;
            out[17][index] = cascade.blend_start;
            out[18][index] = cascade.texel_world_size;
        }
        out[19] = [
            self.cascades.len() as f32,
            depth_bias,
            1.0 / self.shadow_map_size as f32,
            0.0,
        ];
        out[20] = [
            self.camera_forward[0],
            self.camera_forward[1],
            self.camera_forward[2],
            0.0,
        ];
        Ok(out)
    }
}

pub fn plan_cascaded_shadows(
    camera: CascadedShadowCamera,
    light_direction: [f32; 3],
    options: CascadedShadowOptions,
) -> Result<CascadedShadowPlan, String> {
    plan_cascaded_shadows_for_scene(camera, light_direction, options, None)
}

pub fn plan_cascaded_shadows_for_scene(
    camera: CascadedShadowCamera,
    light_direction: [f32; 3],
    mut options: CascadedShadowOptions,
    scene_bounds: Option<SceneWorldBounds>,
) -> Result<CascadedShadowPlan, String> {
    validate(camera, light_direction, options)?;
    let scene_bounds = scene_bounds.map(SceneWorldBounds::validate).transpose()?;
    let forward = normalize(sub(camera.target, camera.eye))?;
    let (camera, active_bounds) = fit_camera_to_scene(camera, forward, scene_bounds, &mut options);
    let right = normalize(cross(forward, normalize(camera.up)?))?;
    let up = cross(right, forward);
    let ray = normalize(light_direction)?;
    let shadow_far = camera.far.min(options.max_shadow_distance);
    let splits = practical_splits(
        camera.near,
        shadow_far,
        options.cascade_count,
        options.split_lambda,
    );
    let mut cascades = Vec::with_capacity(options.cascade_count);
    let mut slice_near = camera.near;
    for &slice_far in &splits {
        let fit_near = cascades
            .last()
            .map_or(slice_near, |previous: &CascadedShadowSlice| {
                previous.blend_start
            });
        let corners = frustum_corners(camera, forward, right, up, fit_near, slice_far);
        let center = average(&corners);
        let radius = quantized_radius(center, &corners);
        let texel_world_size = 2.0 * radius / options.shadow_map_size as f32;
        let snapped = snap_light_center(center, ray, texel_world_size)?;
        let (light_eye, light_far) =
            fit_light_depth(snapped, ray, &corners, active_bounds, options.depth_padding)?;
        let light_up = if ray[1].abs() > 0.98 {
            [0.0, 0.0, 1.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let view_projection = multiply(
            orthographic(radius, 0.0, light_far),
            look_at(light_eye, add(light_eye, ray), light_up)?,
        );
        let blend_start = slice_far - (slice_far - slice_near) * options.blend_ratio;
        cascades.push(CascadedShadowSlice {
            near: slice_near,
            far: slice_far,
            blend_start,
            radius,
            light_far,
            texel_world_size,
            view_projection,
            corners,
        });
        slice_near = slice_far;
    }
    Ok(CascadedShadowPlan {
        light_direction: ray,
        shadow_map_size: options.shadow_map_size,
        camera_forward: forward,
        cascades,
    })
}

fn fit_camera_to_scene(
    mut camera: CascadedShadowCamera,
    forward: [f32; 3],
    bounds: Option<SceneWorldBounds>,
    options: &mut CascadedShadowOptions,
) -> (CascadedShadowCamera, Option<SceneWorldBounds>) {
    let Some(bounds) = bounds else {
        return (camera, None);
    };
    let (minimum, maximum) = bounds.projected_range(camera.eye, forward);
    let shadow_far = camera.far.min(options.max_shadow_distance);
    let near = camera.near.max(minimum - 0.25);
    let far = shadow_far.min(maximum + 0.25);
    if far <= near + 1e-3 {
        return (camera, None);
    }
    camera.near = near;
    options.max_shadow_distance = far;
    (camera, Some(bounds))
}

fn fit_light_depth(
    center: [f32; 3],
    ray: [f32; 3],
    frustum: &[[f32; 3]; 8],
    scene: Option<SceneWorldBounds>,
    padding: f32,
) -> Result<([f32; 3], f32), String> {
    let mut range = frustum
        .iter()
        .map(|corner| dot(sub(*corner, center), ray))
        .fold((f32::INFINITY, f32::NEG_INFINITY), |range, value| {
            (range.0.min(value), range.1.max(value))
        });
    if let Some(scene) = scene {
        let projected = scene.projected_range(center, ray);
        range = (range.0.min(projected.0), range.1.max(projected.1));
    }
    let far = range.1 - range.0 + 2.0 * padding;
    if !far.is_finite() || !(1e-3..=200_000.0).contains(&far) {
        return Err("scene-fitted cascaded shadow depth range is unsupported".into());
    }
    let eye = add(center, scale(ray, range.0 - padding));
    if eye.iter().any(|value| !value.is_finite()) {
        return Err("scene-fitted cascaded shadow eye exceeds float32".into());
    }
    Ok((eye, far))
}

fn validate(
    camera: CascadedShadowCamera,
    light: [f32; 3],
    options: CascadedShadowOptions,
) -> Result<(), String> {
    if !(2..=MAX_CASCADES).contains(&options.cascade_count) {
        return Err("cascade count must be in 2..4".into());
    }
    if options.shadow_map_size < 64 || !options.shadow_map_size.is_power_of_two() {
        return Err("shadow map size must be a power of two and at least 64".into());
    }
    let values = [
        camera.vertical_fov_radians,
        camera.aspect,
        camera.near,
        camera.far,
        options.split_lambda,
        options.max_shadow_distance,
        options.depth_padding,
        options.blend_ratio,
    ];
    if !values.into_iter().all(f32::is_finite)
        || camera.vertical_fov_radians <= 0.0
        || camera.vertical_fov_radians >= std::f32::consts::PI
        || camera.aspect <= 0.0
        || camera.near <= 0.0
        || camera.far <= camera.near
        || options.max_shadow_distance <= camera.near
        || !(0.0..=1.0).contains(&options.split_lambda)
        || options.depth_padding < 0.0
        || !(0.0..=0.5).contains(&options.blend_ratio)
    {
        return Err("invalid cascaded shadow camera or options".into());
    }
    normalize(light)?;
    normalize(sub(camera.target, camera.eye))?;
    Ok(())
}

use crate::cascaded_shadow_math::{
    add, average, cross, dot, frustum_corners, look_at, multiply, normalize, orthographic,
    practical_splits, quantized_radius, scale, snap_light_center, sub,
};
use crate::scene_bounds::SceneWorldBounds;
