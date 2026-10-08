use super::*;

/// 参与统一灯池的灯数(点/聚;方向光与半球不入池——方向光走方向光通路,
/// 半球无 MegaLight kind,如实不入池不虚报)。
pub(super) fn count_pool_lights(lighting: &DirectionalLighting) -> (usize, usize) {
    let mut points = 0usize;
    let mut spots = 0usize;
    for light in lighting.local_lights.iter() {
        match light.kind {
            LocalLightKind::Point => points += 1,
            LocalLightKind::Spot => spots += 1,
            _ => {}
        }
    }
    (points, spots)
}

/// 视空间变换(TS `worldToView` 刚体 look-at 同口径:view z = −depth,前向为
/// −z;native basis 行 = (right, up, forward),第三行取负 = TS 的 backward 行;
/// 点带平移、方向只取行点积)。
pub(crate) fn to_view(view: PlayerView, world: [f32; 3], translate: bool) -> [f64; 3] {
    let [right, up, forward] = view.basis();
    let vector = if translate {
        let eye = view.eye();
        [
            f64::from(world[0]) - f64::from(eye[0]),
            f64::from(world[1]) - f64::from(eye[1]),
            f64::from(world[2]) - f64::from(eye[2]),
        ]
    } else {
        [
            f64::from(world[0]),
            f64::from(world[1]),
            f64::from(world[2]),
        ]
    };
    let dot = |row: [f32; 3]| -> f64 {
        f64::from(row[0]) * vector[0]
            + f64::from(row[1]) * vector[1]
            + f64::from(row[2]) * vector[2]
    };
    [dot(right), dot(up), -dot(forward)]
}

/// 作者局部灯 → 统一灯池(视空间;Disabled/Directional/Hemisphere 不入池)。
/// `ies_mapped` = IES 重映射成功:携带 IES 的 spot 按池序获得行号(与重映射
/// 迭代同序);否则恒 None(因子恒 1)。
pub(super) fn build_view_space_pool(
    lighting: &DirectionalLighting,
    view: PlayerView,
    ies_mapped: bool,
) -> Vec<MegaLight> {
    let mut ies_ordinal = 0usize;
    lighting
        .local_lights
        .iter()
        .filter(|light| matches!(light.kind, LocalLightKind::Point | LocalLightKind::Spot))
        .map(|light: &LocalLight| {
            let is_spot = light.kind == LocalLightKind::Spot;
            let ies_spot_index = if is_spot && light.ies.is_some() && ies_mapped {
                let index = ies_ordinal;
                ies_ordinal += 1;
                Some(index as u32)
            } else {
                None
            };
            MegaLight {
                kind: if is_spot {
                    MegaLightKind::Spot
                } else {
                    MegaLightKind::Point
                },
                position_view: to_view(view, light.position, true),
                range: f64::from(light.range),
                color: [
                    f64::from(light.radiance[0]),
                    f64::from(light.radiance[1]),
                    f64::from(light.radiance[2]),
                ],
                intensity: 1.0,
                decay: f64::from(light.decay),
                direction_view: if is_spot {
                    to_view(view, light.direction, false)
                } else {
                    [0.0, 0.0, 1.0]
                },
                inner_cone_cos: f64::from(light.inner_cos),
                outer_cone_cos: f64::from(light.outer_cos),
                half_extent: [0.0, 0.0],
                two_sided: false,
                ies_spot_index,
            }
        })
        .collect()
}

/// 既有 IES 存储的表节起点(16 灯槽参数节之后;与 `ies_shading` 的
/// `IES_LIGHT_ROWS` 同值,本地互钉避免跨模块私有依赖)。
const IES_TABLE_SECTION_BASE: usize = 16;

/// IES 档位:light-slot 行 → spot-ordinal 行重映射(TS `packIesShading` 的
/// `[0, spotCount)` spot 参数节合同)。池序 spot 携带 IES 时,逐行拷贝既有
/// 4 词(profileIndex/rotationHalfDeg/scaleFactor/metaBase)并把 metaBase
/// 重定基到本载荷表节(spot 行数 + profile 序),表节(元数据 + 展开表,
/// 存储行 16..)逐词拷贝;`evaluate_ies_shading_factor` 的寻址合同
/// (spot 行 4 词 + metaBase→[tableBase,count,halfStep,symmetry])由测试对拍。
/// 任一环节缺失(profile 未声明/槽行缺省/表节缺席)整体 fail-closed 回退
/// None(因子恒 1),绝不半挂载。
pub(super) fn remap_ies_spot_rows(
    lighting: &DirectionalLighting,
    storage_rows: Option<&[[f32; 4]]>,
) -> Option<(Vec<f32>, usize)> {
    let rows = storage_rows?;
    if rows.len() <= IES_TABLE_SECTION_BASE {
        return None;
    }
    let profiles = lighting.light_profiles.as_deref().unwrap_or_default();
    // 一趟携带槽行 4 词 + profile 序(metaBase 重定基需要两者)。
    let mut spot_rows: Vec<([f32; 4], usize)> = Vec::new();
    for (slot, light) in lighting.local_lights.iter().enumerate() {
        let (LocalLightKind::Spot, Some(ies)) = (&light.kind, &light.ies) else {
            continue;
        };
        let profile_index = profiles
            .iter()
            .position(|profile| profile.profile_id == ies.profile_id)?;
        let slot_row = rows.get(slot)?;
        if slot_row[0] < 0.0 {
            // 槽行缺省(-1)= 打包侧未登记该灯的 IES,合同不一致,整体回退。
            return None;
        }
        spot_rows.push((*slot_row, profile_index));
    }
    if spot_rows.is_empty() {
        return None;
    }
    let spot_count = spot_rows.len();
    let table_rows = rows.len() - IES_TABLE_SECTION_BASE;
    let metadata_rows = profiles.len().min(table_rows);
    let mut words = Vec::with_capacity(spot_count * 4 + table_rows * 4);
    for (row, profile_index) in &spot_rows {
        // metaBase 重定基:本载荷表节起点 = spot 行数;profile 元数据行 =
        // 表节起点 + profile 序(与 TS metaBase = spotCount + profileIndex 同式)。
        let mut remapped = *row;
        remapped[3] = (spot_count + profile_index) as f32;
        words.extend_from_slice(&remapped);
    }
    // 表节逐行拷贝;元数据行的 tableBase(word 0)同为 native 存储坐标,
    // 同步重定基:new = spotCount + (old − 16),否则 factor 求值越界回 0。
    for (offset, row) in rows.iter().skip(IES_TABLE_SECTION_BASE).enumerate() {
        let mut copied = *row;
        if offset < metadata_rows && copied[0] >= IES_TABLE_SECTION_BASE as f32 {
            copied[0] = (spot_count as f32) + copied[0] - IES_TABLE_SECTION_BASE as f32;
        }
        words.extend_from_slice(&copied);
    }
    Some((words, spot_count))
}

