use super::*;

pub(crate) fn multiply4(a: &[[f32; 4]; 4], b: &[[f32; 4]; 4]) -> [[f32; 4]; 4] {
    std::array::from_fn(|col| {
        std::array::from_fn(|row| (0..4).map(|k| a[k][row] * b[col][k]).sum::<f32>())
    })
}

/// 列主序 4×4 逆(一般式余子母式;退化行列式 → None,fail-closed)。
pub(crate) fn invert4(m: &[[f32; 4]; 4]) -> Option<[[f32; 4]; 4]> {
    let v = |col: usize, row: usize| f64::from(m[col][row]);
    let cofactor = |c: usize, r: usize| -> f64 {
        let mut minor = [0.0f64; 9];
        let mut index = 0;
        for col in 0..4 {
            for row in 0..4 {
                if col != c && row != r {
                    minor[index] = v(col, row);
                    index += 1;
                }
            }
        }
        let det = minor[0] * (minor[4] * minor[8] - minor[5] * minor[7])
            - minor[1] * (minor[3] * minor[8] - minor[5] * minor[6])
            + minor[2] * (minor[3] * minor[7] - minor[4] * minor[6]);
        if (c + r).is_multiple_of(2) { det } else { -det }
    };
    let determinant: f64 = (0..4).map(|col| v(col, 0) * cofactor(col, 0)).sum();
    if !determinant.is_finite() || determinant.abs() < 1e-12 {
        return None;
    }
    let mut inverse = [[0.0f32; 4]; 4];
    for (row, values) in inverse.iter_mut().enumerate() {
        for (col, value) in values.iter_mut().enumerate() {
            *value = (cofactor(col, row) / determinant) as f32;
        }
    }
    Some(inverse)
}

/// PlayerView → 列主序 worldToView(与 `megalights_runtime::to_view` 同刚体口径:
/// view z = −forward·(p−eye);行 = right/up/−forward,平移 = −R·eye)。
pub(crate) fn world_to_view(view: PlayerView) -> [[f32; 4]; 4] {
    let [right, up, forward] = view.basis();
    let eye = view.eye();
    let rows = [right, up, [-forward[0], -forward[1], -forward[2]]];
    let mut matrix = [[0.0f32; 4]; 4];
    // 列主序:列 col = 各基行向量的第 col 分量(与 to_view 互钉,测试锁定)。
    for row in 0..3 {
        for col in 0..3 {
            matrix[col][row] = rows[row][col];
        }
    }
    for row in 0..3 {
        matrix[3][row] = -(0..3).map(|axis| rows[row][axis] * eye[axis]).sum::<f32>();
    }
    matrix[3][3] = 1.0;
    matrix
}

/// clip → view 组合矩阵(TS packRebuildParams 同式:worldToView × inv(viewProjection);
/// viewProjection = 帧 uniform 前 4 行列主序,即 depth pass 的同一相机)。
pub(crate) fn combined_clip_to_view(
    view: PlayerView,
    frame_view_projection: &[[f32; 4]; 4],
) -> Option<[[f32; 4]; 4]> {
    let world_to_view = world_to_view(view);
    let inverse = invert4(frame_view_projection)?;
    Some(multiply4(&world_to_view, &inverse))
}

/// RIS 帧参数打包(位型契约:整数字段 u32 位型、浮点字段 f32 位型——
/// 真机破案在案,全 f32 位型会把 lightCount 读成 96.0f32≈11.2 亿)。
// Explicit GPU binding and uniform ABI inputs.
#[allow(clippy::too_many_arguments)]
pub(crate) fn pack_ris_params(
    width: u32,
    height: u32,
    light_count: u32,
    frame_seed: u32,
    spatial_enabled: bool,
    temporal_enabled: bool,
    exhaustive: bool,
    alpha_blend: f32,
) -> [u32; RIS_PARAM_WORDS] {
    [
        width,
        height,
        light_count,
        frame_seed,
        u32::from(spatial_enabled),
        u32::from(temporal_enabled),
        u32::from(exhaustive),
        1.0f32.to_bits(), // visibilitySlot(恒 1.0;可见性档未接线)
        alpha_blend.to_bits(),
        0, // visibilityEnabled = 0(M1 逐位)
        0,
        0,
        0,
        0,
        0,
        0,
    ]
}

pub(super) fn pack_rebuild_params(
    combined: &[[f32; 4]; 4],
    width: u32,
    height: u32,
) -> [u32; REBUILD_PARAM_WORDS] {
    let mut words = [0u32; REBUILD_PARAM_WORDS];
    for col in 0..4 {
        for row in 0..4 {
            words[col * 4 + row] = combined[col][row].to_bits();
        }
    }
    words[16] = width;
    words[17] = height;
    words
}

pub(super) fn pack_composite_params(
    width: u32,
    height: u32,
    exposure: f32,
) -> [u32; COMPOSITE_PARAM_WORDS] {
    [width, height, exposure.to_bits(), 0]
}
