//! MegaLights 胜者可见性射线档(2026-10-06 后继切片 2):native 侧两级 TLAS 遮挡——
//! 与 GPU `traceTwoLevelOccluded` 片段族(shadowRayKernel/bvhTraverseTlasWgsl 家族)
//! 同族同合同,复用 [`crate::ray_backend`] 的 BLAS 构建与追踪基础设施。
//!
//! == 合同(与 WGSL deepMegaWriteWinnerRay / deepMegaTraceWinnerVisibility 同式) ==
//! - 胜者射线:视空间表面点经 `view_to_world`(列主序 4×4,DeepMegaVisParams 同布局)
//!   拉回世界;origin 沿线外推 + tMax 双侧收缩(**相对**偏移 1e-3,同 TS
//!   `MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE`——万灯距离跨度大,绝对偏移远灯失真);
//! - 遮挡语义:hit = 遮挡(mask 0),miss = 可见(mask 1);实例按 `mask & ray_mask`
//!   过滤(透传合同与 TS shadowRayKernel.rayMask 同);
//! - 退化:胜者无效 / 灯点与表面点重合 → 退化射线直通可见(mask 1);
//! - **fail-closed**:无 TLAS 场景(None / 空实例表)→ 可见性恒 1 = M1 旧行为,
//!   与 TS MegaLightsFrameController.visibilitySource = "off" 同义;
//! - 栈溢出哨兵为 GPU 合同(overflow → fail-closed 0);CPU 镜像遍历无递归、
//!   无栈上限,该分支不适用(如实声明,不虚设哨兵)。
//! - 穷举帧不消费本档(GPU build/trace 对 exhaustive 早退;调用方合同)。
//!
//! mask 语义与 [`crate::megalights_ris::MegaLightsFrameInput::visibility`] 对接:
//! self 路径乘本像素、空间分支乘源像素,目标权重保持无遮挡口径(CPU 镜像同式同位)。

use crate::megalights_abi::{MegaLight, MegaSurfaceRow, RisReservoir, MEGALIGHTS_INVALID_LIGHT};
use crate::ray_backend::{trace_occluded, TlasInstance, TraceQuery};

/// 胜者射线自相交偏移(相对射线长度;与 TS megaLightsAbi.ts 同值)。
pub const MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE: f64 = 1e-3;

/// 胜者可见性场景(两级 TLAS;复用 RT 阴影家族的实例记录)。
pub struct MegaLightsVisibilityScene<'a> {
    pub instances: &'a [TlasInstance],
    /// TLAS 实例 mask(缺省语义全通;与 TS DeepMegaVisParams.rayMask 同位)。
    pub ray_mask: u32,
}

/// 列主序 4×4 × 齐次点(WGSL `mat4x4f * vec4f` 同式;DeepMegaVisParams.viewToWorld)。
fn apply_view_to_world(m: &[f32; 16], p: [f64; 3]) -> [f64; 3] {
    let (x, y, z) = (f64::from(m[0]), f64::from(m[4]), f64::from(m[8]));
    [
        x * p[0] + y * p[1] + z * p[2] + f64::from(m[12]),
        f64::from(m[1]) * p[0] + f64::from(m[5]) * p[1] + f64::from(m[9]) * p[2] + f64::from(m[13]),
        f64::from(m[2]) * p[0] + f64::from(m[6]) * p[1] + f64::from(m[10]) * p[2] + f64::from(m[14]),
    ]
}

/// 行主序 3×4 仿射 × 点(实例 world→local;ray_backend trace_tlas_closest 同式)。
fn apply_world_to_local(m: &[f32; 12], p: [f32; 3]) -> [f32; 3] {
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
}

/// 行主序 3×4 仿射 × 方向(平移不参与)。
fn apply_world_to_local_direction(m: &[f32; 12], d: [f32; 3]) -> [f32; 3] {
    [
        m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
        m[4] * d[0] + m[5] * d[1] + m[6] * d[2],
        m[8] * d[0] + m[9] * d[1] + m[10] * d[2],
    ]
}

/// 两级 TLAS 遮挡查询(traceTwoLevelOccluded 同族):逐实例 mask 过滤 → 逆变换到
/// 局部 → BLAS any-hit;任意实例命中即遮挡(实例粒度早退)。
fn trace_two_level_occluded(instances: &[TlasInstance], origin: [f64; 3], direction: [f64; 3], t_max: f64, ray_mask: u32) -> bool {
    if !(t_max > 0.0) {
        return false;
    }
    let origin_f32 = [origin[0] as f32, origin[1] as f32, origin[2] as f32];
    let direction_f32 = [direction[0] as f32, direction[1] as f32, direction[2] as f32];
    for instance in instances {
        if instance.mask & ray_mask == 0 {
            continue;
        }
        let local_origin = apply_world_to_local(&instance.world_to_local, origin_f32);
        let local_direction = apply_world_to_local_direction(&instance.world_to_local, direction_f32);
        let scale = (local_direction[0] * local_direction[0]
            + local_direction[1] * local_direction[1]
            + local_direction[2] * local_direction[2])
            .sqrt();
        if !(scale > 0.0) {
            continue;
        }
        let query = TraceQuery {
            ox: local_origin[0],
            oy: local_origin[1],
            oz: local_origin[2],
            dx: local_direction[0] / scale,
            dy: local_direction[1] / scale,
            dz: local_direction[2] / scale,
            t_max: (t_max as f32) * scale,
        };
        if trace_occluded(&instance.blas_vertices, &instance.blas_indices, &instance.blas, &query) {
            return true;
        }
    }
    false
}

/// 胜者可见性 mask 构建器:趟一蓄水池 → 逐像素胜者射线 → 两级 TLAS 遮挡。
/// 返回 `w×h` f32(1.0 = 可见 / 0.0 = 遮挡),直接喂
/// [`crate::megalights_ris::MegaLightsFrameInput::visibility`]。
///
/// fail-closed:`scene` 为 None 或实例表为空 → 全 1(= M1 旧行为,不 trace)。
pub fn winner_visibility_mask(
    lights: &[MegaLight],
    surfaces: &[MegaSurfaceRow],
    built: &[RisReservoir],
    view_to_world: &[f32; 16],
    scene: Option<&MegaLightsVisibilityScene<'_>>,
) -> Vec<f32> {
    let pixel_count = surfaces.len();
    let Some(scene) = scene else {
        return vec![1.0; pixel_count];
    };
    if scene.instances.is_empty() {
        return vec![1.0; pixel_count];
    }
    let mut mask = vec![1.0f32; pixel_count];
    for (pixel_index, reservoir) in built.iter().enumerate().take(pixel_count) {
        if reservoir.winner == MEGALIGHTS_INVALID_LIGHT || reservoir.m == 0 {
            continue; // 退化射线直通可见(GPU tMax=0 同语义)。
        }
        let position_view = [surfaces[pixel_index][0][0], surfaces[pixel_index][0][1], surfaces[pixel_index][0][2]];
        let world_origin = apply_view_to_world(view_to_world, position_view);
        let light = &lights[reservoir.winner as usize];
        let world_target = apply_view_to_world(view_to_world, light.position_view);
        let delta = [
            world_target[0] - world_origin[0],
            world_target[1] - world_origin[1],
            world_target[2] - world_origin[2],
        ];
        let distance = f64::hypot(f64::hypot(delta[0], delta[1]), delta[2]);
        if !(distance > 0.0) {
            continue;
        }
        let direction = [delta[0] / distance, delta[1] / distance, delta[2] / distance];
        let epsilon = distance * MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE;
        let ray_origin = [
            world_origin[0] + direction[0] * epsilon,
            world_origin[1] + direction[1] * epsilon,
            world_origin[2] + direction[2] * epsilon,
        ];
        let ray_t_max = distance - epsilon - epsilon;
        if trace_two_level_occluded(scene.instances, ray_origin, direction, ray_t_max, scene.ray_mask) {
            mask[pixel_index] = 0.0;
        }
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::megalights_abi::{MegaLight, MegaLightKind, RisReservoir};
    use crate::ray_backend::build_bvh;
    use std::rc::Rc;

    /// 单点灯(世界原点上方)。
    fn light_at(position: [f64; 3]) -> MegaLight {
        MegaLight {
            kind: MegaLightKind::Point,
            position_view: position,
            range: 0.0,
            color: [1.0, 1.0, 1.0],
            intensity: 4.0,
            decay: 2.0,
            ..MegaLight::default()
        }
    }

    /// 行主序恒等 world→local 实例。
    fn instance(vertices: Vec<f32>, indices: Vec<u32>, mask: u32) -> TlasInstance {
        let blas = build_bvh(&vertices, &indices).expect("blas builds");
        TlasInstance {
            id: 0,
            blas_vertices: Rc::new(vertices),
            blas_indices: Rc::new(indices),
            blas,
            world_to_local: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            mask,
        }
    }

    const IDENTITY_VIEW_TO_WORLD: [f32; 16] = [
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ];

    fn surface_at(position: [f64; 3]) -> MegaSurfaceRow {
        [[position[0], position[1], position[2], 0.0], [0.0, 1.0, 0.0, 0.2], [0.8, 0.7, 0.6, 0.0]]
    }

    fn reservoir_with(winner: u32) -> RisReservoir {
        RisReservoir { weight_sum: 1.0, winner, m: 1 }
    }

    /// fail-closed:无场景(None / 空实例表)→ 可见性恒 1 = 旧行为。
    #[test]
    fn fail_closed_without_scene_returns_all_visible() {
        let lights = [light_at([0.0, 4.0, 0.0])];
        let surfaces = [surface_at([0.0, 0.0, 0.0]), surface_at([1.0, 0.0, 0.0])];
        let built = [reservoir_with(0), reservoir_with(0)];
        let none = winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, None);
        assert_eq!(none, vec![1.0, 1.0]);
        let instances: Vec<TlasInstance> = Vec::new();
        let empty = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0xffff_ffff };
        let empty_mask = winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&empty));
        assert_eq!(empty_mask, vec![1.0, 1.0]);
    }

    /// 竖墙遮挡:墙 x=0.5(y,z ∈ [-2,2]),灯在 x=2、表面在 x=0 → 连线穿墙 → 0;
    /// 无胜者像素 → 1。
    #[test]
    fn wall_occludes_winner_ray_and_degenerate_paths_stay_visible() {
        let lights = [light_at([2.0, 0.0, 0.0])];
        let surfaces = [surface_at([0.0, 0.0, 0.0]), surface_at([0.0, 1.0, 3.0])];
        let built = [reservoir_with(0), reservoir_with(MEGALIGHTS_INVALID_LIGHT)];
        let occluder = instance(
            vec![
                0.5, -2.0, -2.0, //
                0.5, 2.0, -2.0, //
                0.5, 2.0, 2.0, //
                0.5, -2.0, 2.0,
            ],
            vec![0, 1, 2, 0, 2, 3],
            0xffff_ffff,
        );
        let instances = vec![occluder];
        let scene = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0xffff_ffff };
        let mask = winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&scene));
        assert_eq!(mask[0], 0.0, "ray crossing the wall must be occluded");
        assert_eq!(mask[1], 1.0, "invalid winner degenerates to visible");
        // 遮挡像素直接喂帧输入:shade 侧乘 0 → 全黑(与 ris_tests 可见性腿同链)。
        assert!(lights[0].intensity > 0.0);
    }

    /// 实例 mask 过滤:rayMask 不含实例 → 几何上遮挡也判可见(透传合同)。
    #[test]
    fn ray_mask_filters_instances() {
        let lights = [light_at([2.0, 0.0, 0.0])];
        let surfaces = [surface_at([0.0, 0.0, 0.0])];
        let built = [reservoir_with(0)];
        let occluder = instance(
            vec![
                0.5, -2.0, -2.0, //
                0.5, 2.0, -2.0, //
                0.5, 2.0, 2.0, //
                0.5, -2.0, 2.0,
            ],
            vec![0, 1, 2, 0, 2, 3],
            0b10,
        );
        let instances = vec![occluder];
        let blocked = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0b10 };
        assert_eq!(
            winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&blocked))[0],
            0.0
        );
        let bypassed = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0b01 };
        assert_eq!(
            winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&bypassed))[0],
            1.0
        );
    }

    /// 平移实例:world_to_local 把实例盒搬到射线路径上才遮挡(两级变换合同;
    /// world = local + translation 语义经逆矩阵验证)。
    #[test]
    fn translated_instance_transforms_rays() {
        let lights = [light_at([2.0, 0.0, 0.0])];
        let surfaces = [surface_at([0.0, 0.0, 0.0])];
        let built = [reservoir_with(0)];
        // 单位盒建在原点附近,world_to_local = 平移 (-4,0,0) → 实例世界位置 x∈[3.5,7.5]
        // 不在 x∈(0,2) 射线路径上 → 可见。
        let mut off_path = instance(
            vec![
                -0.5, -2.0, -2.0, //
                -0.5, 2.0, -2.0, //
                -0.5, 2.0, 2.0, //
                -0.5, -2.0, 2.0,
            ],
            vec![0, 1, 2, 0, 2, 3],
            0xffff_ffff,
        );
        off_path.world_to_local = [1.0, 0.0, 0.0, 4.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        // 注意:local = M × world 平移方向为 +4 → 实例世界盒 x∈[-4.5,-0.5],仍在路径外。
        let instances = vec![off_path];
        let scene = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0xffff_ffff };
        assert_eq!(
            winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&scene))[0],
            1.0,
            "instance transformed off the ray path must not occlude"
        );
        // 平移 (-0.25,0,0)(local = world + 0.25)→ 实例世界盒 x∈[0.25,0.75],横穿路径 → 遮挡。
        let mut on_path = instance(
            vec![
                -0.5, -2.0, -2.0, //
                -0.5, 2.0, -2.0, //
                -0.5, 2.0, 2.0, //
                -0.5, -2.0, 2.0,
            ],
            vec![0, 1, 2, 0, 2, 3],
            0xffff_ffff,
        );
        on_path.world_to_local = [1.0, 0.0, 0.0, -0.75, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let instances = vec![on_path];
        let scene = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0xffff_ffff };
        assert_eq!(
            winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&scene))[0],
            0.0,
            "instance transformed onto the ray path must occlude"
        );
    }

    /// 相对偏移合同:origin 外推 + tMax 双侧收缩各 distance × 1e-3,防端点自相交
    /// ——板面穿过**表面点**或**灯点**时,无偏射线会自命中,bias 后直通可见;
    /// 板面在路径中段仍照常遮挡(bias 只保护端点,不豁免中途几何)。
    #[test]
    fn relative_bias_protects_endpoints_not_midpath() {
        let lights = [light_at([2.0, 0.0, 0.0])];
        let surfaces = [surface_at([0.0, 0.0, 0.0])];
        let built = [reservoir_with(0)];
        let wall = |wall_x: f32| {
            instance(
                vec![
                    wall_x, -2.0, -2.0, //
                    wall_x, 2.0, -2.0, //
                    wall_x, 2.0, 2.0, //
                    wall_x, -2.0, 2.0,
                ],
                vec![0, 1, 2, 0, 2, 3],
                0xffff_ffff,
            )
        };
        // 板面在表面点(x=0):bias 起点已越过(x≈2e-3)→ 可见。
        let instances = vec![wall(0.0)];
        let scene = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0xffff_ffff };
        assert_eq!(
            winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&scene))[0],
            1.0,
            "wall through the surface point must be skipped by the origin bias"
        );
        // 板面在灯点(x=2):tMax 收缩后(x≤1.998)够不到 → 可见。
        let instances = vec![wall(2.0)];
        let scene = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0xffff_ffff };
        assert_eq!(
            winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&scene))[0],
            1.0,
            "wall through the light point must be skipped by the tMax shrink"
        );
        // 板面在路径中段(x=0.5):照常遮挡。
        let instances = vec![wall(0.5)];
        let scene = MegaLightsVisibilityScene { instances: &instances, ray_mask: 0xffff_ffff };
        assert_eq!(
            winner_visibility_mask(&lights, &surfaces, &built, &IDENTITY_VIEW_TO_WORLD, Some(&scene))[0],
            0.0,
            "mid-path wall must occlude regardless of the endpoint bias"
        );
    }
}
