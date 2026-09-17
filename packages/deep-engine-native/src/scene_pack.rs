use crate::contract::{AlphaMode, ShadingModel};
use crate::scene::{PACKED_INSTANCE_FLOATS, PackedInstance};

pub(super) fn pack_instance(
    model: &[f32; 16],
    normal: [f32; 12],
    material: &crate::contract::PbrMaterial,
    determinant_sign: f32,
    flags: f32,
) -> PackedInstance {
    let mut packed = [0.0; PACKED_INSTANCE_FLOATS];
    packed[..12].copy_from_slice(&[
        model[0], model[4], model[8], model[12], model[1], model[5], model[9], model[13], model[2],
        model[6], model[10], model[14],
    ]);
    packed[12..24].copy_from_slice(&normal);
    packed[24..28].copy_from_slice(&[
        material.base_color[0],
        material.base_color[1],
        material.base_color[2],
        material.metallic,
    ]);
    packed[28..32].copy_from_slice(&[
        material.roughness,
        material
            .alpha_cutoff
            .unwrap_or(if material.alpha_mode == Some(AlphaMode::Blend) {
                0.0
            } else {
                0.5
            }),
        determinant_sign,
        flags
            + if material.alpha_mode == Some(AlphaMode::Blend) && material.alpha_cutoff.is_some() {
                2.0
            } else {
                0.0
            },
    ]);
    let emissive = material.emissive_factor.unwrap_or([0.0; 3]);
    packed[32..36].copy_from_slice(&[
        emissive[0],
        emissive[1],
        emissive[2],
        material.base_color_alpha.unwrap_or(1.0),
    ]);
    packed
}

pub(super) fn surface_flags(
    alpha_mode: AlphaMode,
    premultiplied: bool,
    double_sided: bool,
    receive_shadow: Option<bool>,
    shading_model: Option<ShadingModel>,
) -> f32 {
    let alpha = match alpha_mode {
        AlphaMode::Opaque => 0,
        AlphaMode::Mask => 2,
        AlphaMode::Blend => 4,
    };
    // 与 Browser 实例 ABI 逐位对拍:1 double、16 禁用接收阴影、64 unlit、128 premultiplied(仅 BLEND)。
    (alpha
        + usize::from(double_sided)
        + 128 * usize::from(premultiplied)
        + 16 * usize::from(receive_shadow == Some(false))
        + 64 * usize::from(shading_model == Some(ShadingModel::Unlit))) as f32
}

pub(super) fn geometry_center(vertices: &[f32], indices: &[u32]) -> [f32; 3] {
    let (mut minimum, mut maximum) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    for &index in indices {
        let offset = index as usize * 6;
        let vertex = &vertices[offset..offset + 3];
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(vertex[axis]);
            maximum[axis] = maximum[axis].max(vertex[axis]);
        }
    }
    [
        minimum[0] * 0.5 + maximum[0] * 0.5,
        minimum[1] * 0.5 + maximum[1] * 0.5,
        minimum[2] * 0.5 + maximum[2] * 0.5,
    ]
}

pub(super) fn transform_center(matrix: &[f32; 16], center: [f32; 3]) -> Result<[f32; 3], String> {
    let result = [
        matrix[0] * center[0] + matrix[4] * center[1] + matrix[8] * center[2] + matrix[12],
        matrix[1] * center[0] + matrix[5] * center[1] + matrix[9] * center[2] + matrix[13],
        matrix[2] * center[0] + matrix[6] * center[1] + matrix[10] * center[2] + matrix[14],
    ];
    if result.iter().any(|value| !value.is_finite()) {
        return Err("transparent world bounding-box center exceeds float32 range".into());
    }
    Ok(result)
}

pub(super) fn determinant3(model: &[f32; 16]) -> f32 {
    let (a, d, g) = (model[0], model[1], model[2]);
    let (b, e, h) = (model[4], model[5], model[6]);
    let (c, f, i) = (model[8], model[9], model[10]);
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
}

pub(super) fn column_norm(model: &[f32; 16], offset: usize) -> f32 {
    (model[offset] * model[offset]
        + model[offset + 1] * model[offset + 1]
        + model[offset + 2] * model[offset + 2])
        .sqrt()
}

pub(super) fn inverse_transpose3(model: &[f32; 16], determinant: f32) -> [f32; 12] {
    let (a, d, g) = (model[0], model[1], model[2]);
    let (b, e, h) = (model[4], model[5], model[6]);
    let (c, f, i) = (model[8], model[9], model[10]);
    let inverse = 1.0 / determinant;
    [
        (e * i - f * h) * inverse,
        (c * h - b * i) * inverse,
        (b * f - c * e) * inverse,
        0.0,
        (f * g - d * i) * inverse,
        (a * i - c * g) * inverse,
        (c * d - a * f) * inverse,
        0.0,
        (d * h - e * g) * inverse,
        (b * g - a * h) * inverse,
        (a * e - b * d) * inverse,
        0.0,
    ]
}
