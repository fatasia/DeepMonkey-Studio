// megalights RIS 求值函数(体量门拆分;与 megalights_ris.rs 同属一个模块域)。
// 这些函数依赖 megalights_ris 中定义的公共类型与辅助函数;
// 通过 #[path] + pub use 重新导出保持原路径。

use super::*;

/// 单灯贡献 + IES 因子注入(2026-10-06;TS evaluateMegaLightCpu 的 iesFactor 钩子
/// 同位:因子 = evaluate_ies_shading_factor(打包字节, 行号, 打包方向, surfaceToLight),
/// 乘在 cone 侧——目标权重与胜者着色同变,与 WGSL deepMegaContribution 一致;
/// ies=None 或灯无行号 → 恒 1.0,与 v1 逐位一致)。
pub fn evaluate_mega_light_ies(
    light: &MegaLight,
    surface: &MegaSurfaceRow,
    ies: Option<&MegaLightsIesPacking<'_>>,
) -> [f64; 3] {
    let (position, normal, view, base_color, metallic, roughness) = mega_surface_decode(surface);
    if light.kind == MegaLightKind::AreaRect {
        let to_surface = [
            position[0] - light.position_view[0],
            position[1] - light.position_view[1],
            position[2] - light.position_view[2],
        ];
        let facing = dot3(
            to_surface,
            safe_normalize(light.direction_view, [0.0, 0.0, 1.0]),
        );
        if !light.two_sided && facing < 0.0 {
            return [0.0; 3];
        }
        if light.range > 0.0 && hypot3(to_surface) > light.range {
            return [0.0; 3];
        }
        return mega_light_brdf(
            light,
            position,
            normal,
            view,
            base_color,
            metallic,
            roughness,
            mega_area_light_extent_factor(light),
        );
    }
    let to_light = [
        light.position_view[0] - position[0],
        light.position_view[1] - position[1],
        light.position_view[2] - position[2],
    ];
    let distance = f64::max(hypot3(to_light), 1e-8);
    // surfaceToLight 提升到锥分支外(与 TS 同位:IES 钩子与锥共用同一单位向量)。
    let surface_to_light = [
        to_light[0] / distance,
        to_light[1] / distance,
        to_light[2] / distance,
    ];
    let mut cone = 1.0;
    if light.kind == MegaLightKind::Spot {
        let direction = safe_normalize(light.direction_view, [0.0, 0.0, 1.0]);
        let cone_scale = if light.inner_cone_cos == light.outer_cone_cos {
            0.0
        } else {
            1.0 / (light.inner_cone_cos - light.outer_cone_cos)
        };
        cone = mega_light_spot_cone(
            -dot3(surface_to_light, direction),
            light.outer_cone_cos,
            cone_scale,
        );
    }
    if cone <= 0.0 {
        return [0.0; 3];
    }
    let ies_factor = match (ies, light.ies_spot_index) {
        (Some(packing), Some(row)) => evaluate_ies_shading_factor(
            packing,
            row as usize,
            safe_normalize(light.direction_view, [0.0, 0.0, 1.0]),
            surface_to_light,
        ),
        _ => 1.0,
    };
    mega_light_brdf(
        light,
        position,
        normal,
        view,
        base_color,
        metallic,
        roughness,
        cone * ies_factor,
    )
}

