//! C3 切片一/三(2026-09-19):实例级场景 diff——"过度失效"治理的数据核。
//!
//! R6-2 实测:单实例变更触发 5000 实例全量 prepare(scene_update 88.6%)。
//! 本模块给出纯函数 diff:两次 RenderInstance 列表之间,是 Identical、
//! TransformOnly(哪些索引只动了 transform)、ShadowFlagOnly(只动了阴影
//! 标志)、LodOnly(只动了 LOD profile)还是 Structural(数量/身份/混合
//! 变化——必须走全量重建)。
//!
//! 确定性纪律:比较按字节(transform 逐 f32 位比较,-0 与 +0 视为不同位型
//! 但同一数值——合同上源数据经 1e-3 量化,此处用位比较避免 NaN 语义分歧;
//! NaN 按 != 自身处理,视为变化)。索引升序输出,供 partial write 使用。
//!
//! 阴影标志按 prepare_scene 的语义归一化(`unwrap_or(true)`):None 与
//! Some(true) 等价,不判变化。单一维度变化才给快路径分类;两个及以上维度
//! 同帧变化保守归 Structural(全量路径永远正确)。

use deep_engine_native::contract::RenderInstance;

#[derive(Debug, Clone, PartialEq)]
pub enum SceneInstanceDiff {
    /// 列表完全一致(逐字段语义相等;阴影标志按 unwrap_or(true) 归一)。
    Identical,
    /// 数量/顺序/身份/几何/材质/阴影/LOD 全同,仅这些索引的 transform 变化。
    /// 索引严格升序;非空。
    TransformOnly { changed_indices: Vec<u32> },
    /// 仅阴影标志变化(其余维度全同)。cast_shadow 参与 BatchKey(翻转可能
    /// 批重排),receive_shadow 只进实例词 31(surface flags,批布局稳定)。
    /// `cast_changed` 区分两条通道:receive-only 可单行原位写;cast 变化
    /// 走资源复用的场景刷新 staging(全实例重打包)。
    ShadowFlagOnly {
        changed_indices: Vec<u32>,
        cast_changed: bool,
    },
    /// 仅 LOD profile 变化。lod_profile 参与 BatchKey(批可能重排),几何/
    /// 纹理不与 LOD 耦合(按 (id,revision) 版本键独立复用)——分类降级为
    /// "重 prepare + 重 culling/lod + 资源全复用"的刷新 staging,不重上传
    /// 纹理/几何。
    LodOnly { changed_indices: Vec<u32> },
    /// 其余一切(增删/重排/身份字段变化/多维度同帧变化)——必须走全量重建。
    Structural,
}

pub fn diff_scene_instances(
    previous: &[RenderInstance],
    next: &[RenderInstance],
) -> SceneInstanceDiff {
    if previous.len() != next.len() {
        return SceneInstanceDiff::Structural;
    }
    let mut transforms = Vec::new();
    let mut flags = Vec::new();
    let mut lods = Vec::new();
    let mut cast_changed = false;
    for (index, (before, after)) in previous.iter().zip(next.iter()).enumerate() {
        if !instance_identity_equal(before, after) {
            return SceneInstanceDiff::Structural;
        }
        if before.transform != after.transform {
            transforms.push(index as u32);
        }
        if shadow_flag_changed(before, after) {
            flags.push(index as u32);
            cast_changed =
                cast_changed || cast_enabled(&before.cast_shadow) != cast_enabled(&after.cast_shadow);
        }
        if !lod_equal(before, after) {
            lods.push(index as u32);
        }
    }
    match (
        transforms.is_empty(),
        flags.is_empty(),
        lods.is_empty(),
    ) {
        (true, true, true) => SceneInstanceDiff::Identical,
        (false, true, true) => SceneInstanceDiff::TransformOnly { changed_indices: transforms },
        (true, false, true) => SceneInstanceDiff::ShadowFlagOnly {
            changed_indices: flags,
            cast_changed,
        },
        (true, true, false) => SceneInstanceDiff::LodOnly {
            changed_indices: lods,
        },
        _ => SceneInstanceDiff::Structural,
    }
}

/// 身份字段相等:id/geometry/material。transform/阴影标志/LOD 不在身份内,
/// 由各自维度表达。
fn instance_identity_equal(before: &RenderInstance, after: &RenderInstance) -> bool {
    before.id == after.id && before.geometry == after.geometry && before.material == after.material
}

/// 阴影标志按 prepare_scene 语义比较:None 与 Some(true) 等价。
fn shadow_flag_changed(before: &RenderInstance, after: &RenderInstance) -> bool {
    cast_enabled(&before.cast_shadow) != cast_enabled(&after.cast_shadow)
        || receive_enabled(&before.receive_shadow) != receive_enabled(&after.receive_shadow)
}

fn cast_enabled(value: &Option<bool>) -> bool {
    !matches!(value, Some(false))
}

fn receive_enabled(value: &Option<bool>) -> bool {
    !matches!(value, Some(false))
}

/// LOD profile 相等:levels/hysteresis 逐字段位比较;带 author 选点的
/// profile 一律按"有变化"处理(回落刷新/全量路径,安全)。
fn lod_equal(before: &RenderInstance, after: &RenderInstance) -> bool {
    match (&before.lod, &after.lod) {
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
    fn lod_profile_change_classifies_lod_only() {
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
            SceneInstanceDiff::LodOnly {
                changed_indices: vec![0]
            }
        );
        // None → Some 也是 LOD-only(批键变化,由刷新 staging 重排)。
        let mut added = vec![instance("a", 0.0)];
        added[0].lod = previous[0].lod.clone();
        assert_eq!(
            diff_scene_instances(&[instance("a", 0.0)], &added),
            SceneInstanceDiff::LodOnly {
                changed_indices: vec![0]
            }
        );
    }

    fn with_lod(mut instance: RenderInstance, pixels: f64) -> RenderInstance {
        instance.lod = Some(RenderLodProfile {
            levels: vec![RenderLodLevel {
                geometry: "geo/box-lod".into(),
                min_projected_diameter_pixels: pixels,
                geometric_error: 0.5,
                resident: None,
            }],
            hysteresis_ratio: None,
            author: None,
        });
        instance
    }

    /// receive_shadow 语义归一:None 与 Some(true) 等价不判变化;
    /// Some(false) 翻转归 ShadowFlagOnly(cast_changed=false)。
    #[test]
    fn receive_shadow_change_classifies_shadow_flag_only() {
        let base = vec![instance("a", 0.0), instance("b", 1.0)];
        let mut receive_off = base.clone();
        receive_off[1].receive_shadow = Some(false);
        assert_eq!(
            diff_scene_instances(&base, &receive_off),
            SceneInstanceDiff::ShadowFlagOnly {
                changed_indices: vec![1],
                cast_changed: false
            }
        );
        let mut normalized = base.clone();
        normalized[0].receive_shadow = None;
        assert_eq!(
            diff_scene_instances(&base, &normalized),
            SceneInstanceDiff::Identical
        );
    }

    /// cast_shadow 参与批键:翻转归 ShadowFlagOnly(cast_changed=true);
    /// None 与 Some(true) 归一为同值。
    #[test]
    fn cast_shadow_change_reports_cast_changed() {
        let base = vec![instance("a", 0.0)];
        let mut cast_off = base.clone();
        cast_off[0].cast_shadow = Some(false);
        assert_eq!(
            diff_scene_instances(&base, &cast_off),
            SceneInstanceDiff::ShadowFlagOnly {
                changed_indices: vec![0],
                cast_changed: true
            }
        );
        let mut normalized = base.clone();
        normalized[0].cast_shadow = None;
        assert_eq!(
            diff_scene_instances(&base, &normalized),
            SceneInstanceDiff::Identical
        );
    }

    /// 多维度同帧变化保守归 Structural(全量路径永远正确)。
    #[test]
    fn mixed_dimensions_fall_back_to_structural() {
        let base = vec![with_lod(instance("a", 0.0), 64.0)];
        let mut mixed = vec![with_lod(instance("a", 0.0), 64.0)];
        mixed[0].cast_shadow = Some(false);
        mixed[0].lod.as_mut().unwrap().levels[0].geometric_error = 2.0;
        assert_eq!(
            diff_scene_instances(&base, &mixed),
            SceneInstanceDiff::Structural
        );
        let mut mixed_two = vec![with_lod(instance("a", 0.0), 64.0)];
        mixed_two[0].transform[12] = 3.0;
        mixed_two[0].receive_shadow = Some(false);
        assert_eq!(
            diff_scene_instances(&base, &mixed_two),
            SceneInstanceDiff::Structural
        );
    }

    /// 身份字段(geometry 引用)变化仍是 Structural,不受阴影/LOD 归类影响。
    #[test]
    fn identity_change_is_structural() {
        let base = vec![instance("a", 0.0)];
        let mut geometry_swapped = base.clone();
        geometry_swapped[0].geometry = "geo/other".into();
        assert_eq!(
            diff_scene_instances(&base, &geometry_swapped),
            SceneInstanceDiff::Structural
        );
    }
}
