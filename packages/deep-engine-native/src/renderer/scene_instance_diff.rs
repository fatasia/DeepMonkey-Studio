//! C3 切片一(2026-09-19):实例级场景 diff——"过度失效"治理的数据核。
//!
//! R6-2 实测:单实例变更触发 5000 实例全量 prepare(scene_update 88.6%)。
//! 本模块给出纯函数 diff:两次 RenderInstance 列表之间,是 Identical、
//! TransformOnly(哪些索引只动了 transform)、还是 Structural(数量/身份/
//! 几何/材质/阴影/LOD 任一变化)。
//!
//! 确定性纪律:比较按字节(transform 逐 f32 位比较,-0 与 +0 视为不同位型
//! 但同一数值——合同上源数据经 1e-3 量化,此处用位比较避免 NaN 语义分歧;
//! NaN 按 != 自身处理,视为变化)。索引升序输出,供 partial write 使用。

use deep_engine_native::contract::RenderInstance;

#[derive(Debug, Clone, PartialEq)]
pub enum SceneInstanceDiff {
    /// 列表完全一致(逐字段相等)。
    Identical,
    /// 数量/顺序/身份/几何/材质/阴影/LOD 全同,仅这些索引的 transform 变化。
    /// 索引严格升序;非空。
    TransformOnly { changed_indices: Vec<u32> },
    /// 其余一切(增删/重排/字段变化)——必须走全量重建。
    Structural,
}

pub fn diff_scene_instances(
    previous: &[RenderInstance],
    next: &[RenderInstance],
) -> SceneInstanceDiff {
    if previous.len() != next.len() {
        return SceneInstanceDiff::Structural;
    }
    let mut changed_indices = Vec::new();
    for (index, (before, after)) in previous.iter().zip(next.iter()).enumerate() {
        if !instance_identity_equal(before, after) {
            return SceneInstanceDiff::Structural;
        }
        if before.transform != after.transform {
            changed_indices.push(index as u32);
        }
    }
    if changed_indices.is_empty() {
        SceneInstanceDiff::Identical
    } else {
        SceneInstanceDiff::TransformOnly { changed_indices }
    }
}

/// 身份字段相等:id/geometry/material/cast_shadow/receive_shadow/lod。
/// transform 不在身份内(由 TransformOnly 表达)。
fn instance_identity_equal(before: &RenderInstance, after: &RenderInstance) -> bool {
    before.id == after.id
        && before.geometry == after.geometry
        && before.material == after.material
        && before.cast_shadow == after.cast_shadow
        && before.receive_shadow == after.receive_shadow
        // LOD profile 逐字段比较(RenderLodProfile 未 derive PartialEq);
        // 带 author 选点的 profile 保守按 Structural(回落全量重建,安全)。
        && match (&before.lod, &after.lod) {
            (None, None) => true,
            (Some(before_lod), Some(after_lod)) => {
                before_lod.hysteresis_ratio == after_lod.hysteresis_ratio
                    && before_lod.levels.len() == after_lod.levels.len()
                    && before_lod.levels.iter().zip(after_lod.levels.iter()).all(|(a, b)| {
                        a.geometry == b.geometry
                            && a.min_projected_diameter_pixels == b.min_projected_diameter_pixels
                            && a.geometric_error == b.geometric_error
                            && a.resident == b.resident
                    })
                    && before_lod.author.is_none()
                    && after_lod.author.is_none()
            }
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deep_engine_native::contract::{RenderInstance, RenderLodLevel, RenderLodProfile};

    fn instance(id: &str, x: f32) -> RenderInstance {
        RenderInstance {
            id: id.into(),
            geometry: "geo/box".into(),
            material: "mat/steel".into(),
            transform: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, 2.0, 0.0, 1.0,
            ],
            cast_shadow: Some(true),
            receive_shadow: Some(true),
            lod: None,
        }
    }

    #[test]
    fn identical_lists_report_identical() {
        let instances = vec![instance("a", 0.0), instance("b", 1.0)];
        assert_eq!(
            diff_scene_instances(&instances, &instances),
            SceneInstanceDiff::Identical
        );
    }

    #[test]
    fn transform_only_change_lists_ascending_indices() {
        let previous = vec![instance("a", 0.0), instance("b", 1.0), instance("c", 2.0)];
        let mut next = previous.clone();
        next[2].transform[12] = 5.0;
        next[0].transform[12] = -1.0;
        assert_eq!(
            diff_scene_instances(&previous, &next),
            SceneInstanceDiff::TransformOnly {
                changed_indices: vec![0, 2]
            }
        );
    }

    #[test]
    fn structural_on_count_change() {
        let previous = vec![instance("a", 0.0)];
        let next = vec![instance("a", 0.0), instance("b", 1.0)];
        assert_eq!(
            diff_scene_instances(&previous, &next),
            SceneInstanceDiff::Structural
        );
    }

    #[test]
    fn structural_on_material_change_even_with_same_transform() {
        let mut next = vec![instance("a", 0.0)];
        next[0].material = "mat/glass".into();
        assert_eq!(
            diff_scene_instances(&previous_of(&next), &next),
            SceneInstanceDiff::Structural
        );
    }

    fn previous_of(next: &[RenderInstance]) -> Vec<RenderInstance> {
        next.iter()
            .map(|instance| {
                let mut copy = instance.clone();
                copy.material = "mat/steel".into();
                copy
            })
            .collect()
    }

    #[test]
    fn nan_in_transform_counts_as_change() {
        let previous = vec![instance("a", 0.0)];
        let mut next = vec![instance("a", 0.0)];
        next[0].transform[12] = f32::NAN;
        assert_ne!(
            diff_scene_instances(&previous, &next),
            SceneInstanceDiff::Identical
        );
    }

    #[test]
    fn lod_profile_change_is_structural() {
        let mut previous = vec![instance("a", 0.0)];
        previous[0].lod = Some(RenderLodProfile {
            levels: vec![RenderLodLevel {
                geometry: "geo/box-lod".into(),
                min_projected_diameter_pixels: 64.0,
                geometric_error: 0.5,
                resident: None,
            }],
            hysteresis_ratio: None,
            author: None,
        });
        let next = previous.clone();
        assert_eq!(
            diff_scene_instances(&previous, &next),
            SceneInstanceDiff::Identical
        );
        let mut changed = previous.clone();
        changed[0].lod.as_mut().unwrap().levels[0].geometric_error = 1.0;
        assert_eq!(
            diff_scene_instances(&previous, &changed),
            SceneInstanceDiff::Structural
        );
    }
}
