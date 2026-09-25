use std::collections::HashMap;

use crate::contract::{AlphaMode, RenderPacket, validate_packet};
use crate::scene_pack::*;

pub use crate::mesh_abi::{PACKED_INSTANCE_BYTES, PACKED_INSTANCE_FLOATS};
pub use crate::scene_alpha::{alpha_summary, transparent_batch_order};

pub type PackedInstance = [f32; PACKED_INSTANCE_FLOATS];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeometryKey {
    pub id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DrawBatch {
    pub lod: bool,
    pub cast_shadow: bool,
    pub geometry_index: usize,
    pub material_index: usize,
    pub mirrored: bool,
    pub double_sided: bool,
    pub alpha_mode: AlphaMode,
    /// DE26/C03:仅 Blend 材质可为 true;选择 premultiplied blend 管线变体。
    pub premultiplied: bool,
    pub sort_center: Option<[f32; 3]>,
    pub stable_order: usize,
    pub instance_start: u32,
    pub instance_count: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SceneAlphaSummary {
    pub opaque_batches: usize,
    pub mask_batches: usize,
    pub blend_batches: usize,
    pub double_sided_batches: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedScene {
    pub geometry_keys: Vec<GeometryKey>,
    pub material_ids: Vec<String>,
    pub instance_ids: Vec<String>,
    pub instances: Vec<PackedInstance>,
    pub batches: Vec<DrawBatch>,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct BatchKey {
    lod_profile: Option<usize>,
    cast_shadow: bool,
    geometry_index: usize,
    material_index: usize,
    mirrored: bool,
    double_sided: bool,
    alpha_mode: AlphaMode,
    premultiplied: bool,
    blend_instance: Option<usize>,
}

struct PendingBatch {
    key: BatchKey,
    sort_center: Option<[f32; 3]>,
    instances: Vec<(String, PackedInstance)>,
}

pub fn prepare_scene(packet: &RenderPacket) -> Result<PreparedScene, String> {
    validate_packet(packet)?;
    let mut geometry_map = HashMap::with_capacity(packet.geometries.len());
    let mut geometry_keys = Vec::with_capacity(packet.geometries.len());
    let mut geometry_centers = Vec::with_capacity(packet.geometries.len());
    for (index, geometry) in packet.geometries.iter().enumerate() {
        if geometry_map.insert(geometry.id.as_str(), index).is_some() {
            return Err(format!("duplicate geometry id {}", geometry.id));
        }
        geometry_keys.push(GeometryKey {
            id: geometry.id.clone(),
            revision: geometry.revision,
        });
        geometry_centers.push(geometry_center(&geometry.vertices, &geometry.indices));
    }

    let mut material_map = HashMap::with_capacity(packet.materials.len());
    let mut material_ids = Vec::with_capacity(packet.materials.len());
    for (index, material) in packet.materials.iter().enumerate() {
        if material_map.insert(material.id.as_str(), index).is_some() {
            return Err(format!("duplicate material id {}", material.id));
        }
        material_ids.push(material.id.clone());
    }

    let mut batch_map = HashMap::new();
    let mut profiles = HashMap::new();
    let mut pending: Vec<PendingBatch> = Vec::new();
    for (instance_order, instance) in packet.instances.iter().enumerate() {
        let geometry_index = geometry_map
            .get(instance.geometry.as_str())
            .copied()
            .ok_or_else(|| format!("instance {} geometry is missing", instance.id))?;
        let material_index = material_map
            .get(instance.material.as_str())
            .copied()
            .ok_or_else(|| format!("instance {} material is missing", instance.id))?;
        let determinant = determinant3(&instance.transform);
        let scale = column_norm(&instance.transform, 0)
            * column_norm(&instance.transform, 4)
            * column_norm(&instance.transform, 8);
        if !determinant.is_finite() || scale == 0.0 || determinant.abs() < scale * 1e-8 {
            return Err(format!("instance {} transform is singular", instance.id));
        }
        let material = &packet.materials[material_index];
        let double_sided = material.double_sided.unwrap_or(false);
        let alpha_mode = material.alpha_mode.unwrap_or(AlphaMode::Opaque);
        let premultiplied =
            alpha_mode == AlphaMode::Blend && material.premultiplied_alpha.unwrap_or(false);
        let mirrored = determinant.is_sign_negative();
        let sort_center = (alpha_mode == AlphaMode::Blend)
            .then(|| transform_center(&instance.transform, geometry_centers[geometry_index]))
            .transpose()?;
        let lod_profile = instance.lod.as_ref().map(|profile| {
            let key = (
                profile.author.as_ref().map(|a| {
                    (
                        a.revision.to_bits(),
                        a.selected_levels.clone(),
                        a.levels
                            .iter()
                            .map(|l| (l.distance.to_bits(), l.hysteresis.to_bits()))
                            .collect::<Vec<_>>(),
                    )
                }),
                profile.hysteresis_ratio().to_bits(),
                profile
                    .levels
                    .iter()
                    .map(|level| {
                        (
                            level.geometry.clone(),
                            level.min_projected_diameter_pixels.to_bits(),
                            level.geometric_error.to_bits(),
                            level.is_resident(),
                        )
                    })
                    .collect::<Vec<_>>(),
            );
            let next = profiles.len();
            *profiles.entry(key).or_insert(next)
        });
        let key = BatchKey {
            lod_profile,
            cast_shadow: instance.cast_shadow.unwrap_or(true),
            geometry_index,
            material_index,
            mirrored: !double_sided && mirrored,
            double_sided,
            alpha_mode,
            premultiplied,
            blend_instance: (alpha_mode == AlphaMode::Blend).then_some(instance_order),
        };
        let batch_index = match batch_map.get(&key) {
            Some(&index) => index,
            None => {
                let index = pending.len();
                batch_map.insert(key, index);
                pending.push(PendingBatch {
                    key,
                    sort_center,
                    instances: Vec::new(),
                });
                index
            }
        };
        pending[batch_index].instances.push((
            instance.id.clone(),
            pack_instance(
                &instance.transform,
                inverse_transpose3(&instance.transform, determinant),
                material,
                if mirrored { -1.0 } else { 1.0 },
                surface_flags(
                    alpha_mode,
                    premultiplied,
                    double_sided,
                    instance.receive_shadow,
                    material.shading_model,
                    material.fog,
                ) + 256.0 * f32::from(instance.outline == Some(true)),
            ),
        ));
    }

    let mut instance_ids = Vec::with_capacity(packet.instances.len());
    let mut instances = Vec::with_capacity(packet.instances.len());
    let mut batches = Vec::with_capacity(pending.len());
    for (stable_order, batch) in pending.into_iter().enumerate() {
        let instance_start = instances.len() as u32;
        let instance_count = batch.instances.len() as u32;
        for (id, instance) in batch.instances {
            instance_ids.push(id);
            instances.push(instance);
        }
        batches.push(DrawBatch {
            lod: batch.key.lod_profile.is_some(),
            cast_shadow: batch.key.cast_shadow,
            geometry_index: batch.key.geometry_index,
            material_index: batch.key.material_index,
            mirrored: batch.key.mirrored,
            double_sided: batch.key.double_sided,
            alpha_mode: batch.key.alpha_mode,
            premultiplied: batch.key.premultiplied,
            sort_center: batch.sort_center,
            stable_order,
            instance_start,
            instance_count,
        });
    }

    Ok(PreparedScene {
        geometry_keys,
        material_ids,
        instance_ids,
        instances,
        batches,
    })
}

/// C3 transform-only 快路径的纯重算核:奇异性合同与 prepare_scene 一致,
/// 返回(词 0..24 = 模型列主序 12 + 逆转置法线 12,镜像符号 ±1)。
/// gpu_scene 的 partial-write 由此保证与 pack_instance 逐位一致。
pub fn recompute_transform_update(
    model: &[f32; 16],
    index: usize,
) -> Result<([f32; 24], f32), String> {
    let determinant = determinant3(model);
    let scale = column_norm(model, 0) * column_norm(model, 4) * column_norm(model, 8);
    if !determinant.is_finite() || scale == 0.0 || determinant.abs() < scale * 1e-8 {
        return Err(format!("instance transform is singular (row {index})"));
    }
    let mut words = [0.0_f32; 24];
    words[..12].copy_from_slice(&[
        model[0], model[4], model[8], model[12], model[1], model[5], model[9], model[13], model[2],
        model[6], model[10], model[14],
    ]);
    words[12..24].copy_from_slice(&inverse_transpose3(model, determinant));
    Ok((
        words,
        if determinant.is_sign_negative() {
            -1.0
        } else {
            1.0
        },
    ))
}

/// C3 receive-shadow-only 快路径的纯重算核:重算实例缓冲词 31(surface
/// flags + BLEND alpha_cutoff 附加位),与 `pack_instance` 的词 31 逐位
/// 一致(测试钉死)。材质表面字段由调用方守卫保证全同,唯一自由度是
/// `receive_shadow`;cast_shadow 不进实例词(它参与批键,走批重排路径)。
pub fn recompute_surface_flags(
    material: &crate::contract::PbrMaterial,
    receive_shadow: Option<bool>,
) -> f32 {
    let alpha_mode = material.alpha_mode.unwrap_or(AlphaMode::Opaque);
    let premultiplied =
        alpha_mode == AlphaMode::Blend && material.premultiplied_alpha.unwrap_or(false);
    let double_sided = material.double_sided.unwrap_or(false);
    surface_flags(
        alpha_mode,
        premultiplied,
        double_sided,
        receive_shadow,
        material.shading_model,
        material.fog,
    ) + if material.alpha_mode == Some(AlphaMode::Blend) && material.alpha_cutoff.is_some() {
        2.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod transform_update_tests {
    use super::*;

    fn model(x: f32, mirrored: bool) -> [f32; 16] {
        let sign = if mirrored { -1.0 } else { 1.0 };
        [
            2.0 * sign,
            0.0,
            0.0,
            0.0,
            0.0,
            1.5,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            x,
            2.0,
            3.0,
            1.0,
        ]
    }

    #[test]
    fn recompute_matches_pack_instance_words() {
        let material = test_material();
        for mirrored in [false, true] {
            for x in [0.0, -3.5] {
                let model = model(x, mirrored);
                let determinant = determinant3(&model);
                let full = pack_instance(
                    &model,
                    inverse_transpose3(&model, determinant),
                    &material,
                    if mirrored { -1.0 } else { 1.0 },
                    0.0,
                );
                let (words, sign) = recompute_transform_update(&model, 0).unwrap();
                assert_eq!(words, full[..24]);
                assert_eq!(sign, full[30]);
            }
        }
    }

    fn test_material() -> crate::contract::PbrMaterial {
        crate::contract::PbrMaterial {
            id: "mat/steel".into(),
            shading_model: None,
            base_color: [0.2, 0.4, 0.8],
            metallic: 0.7,
            roughness: 0.3,
            ior: None,
            base_color_texture: None,
            metallic_roughness_texture: None,
            normal_texture: None,
            occlusion_texture: None,
            emissive_factor: None,
            emissive_texture: None,
            base_color_alpha: None,
            alpha_mode: None,
            alpha_cutoff: None,
            double_sided: None,
            premultiplied_alpha: None,
            fog: None,
        }
    }

    #[test]
    fn singular_transform_is_rejected() {
        let zero = [0.0_f32; 16];
        assert!(recompute_transform_update(&zero, 3).is_err());
    }

    /// 词 31 重算核与 pack_instance 逐位一致:遍历 alpha 模式 / 双面 /
    /// premultiplied / cutoff / unlit / 接收阴影的全部组合。
    #[test]
    fn recompute_surface_flags_matches_pack_instance_word31() {
        use crate::contract::AlphaMode;
        let mut material = crate::contract::PbrMaterial {
            id: "mat/flags".into(),
            shading_model: None,
            base_color: [0.2, 0.4, 0.8],
            metallic: 0.7,
            roughness: 0.3,
            ior: None,
            base_color_texture: None,
            metallic_roughness_texture: None,
            normal_texture: None,
            occlusion_texture: None,
            emissive_factor: None,
            emissive_texture: None,
            base_color_alpha: None,
            alpha_mode: None,
            alpha_cutoff: None,
            double_sided: None,
            premultiplied_alpha: None,
            fog: None,
        };
        for alpha_mode in [
            None,
            Some(AlphaMode::Opaque),
            Some(AlphaMode::Mask),
            Some(AlphaMode::Blend),
        ] {
            for double_sided in [None, Some(true), Some(false)] {
                for premultiplied in [None, Some(true)] {
                    for cutoff in [None, Some(0.4)] {
                        for unlit in [None, Some(crate::contract::ShadingModel::Unlit)] {
                            for receive in [None, Some(true), Some(false)] {
                                for fog in [None, Some(true), Some(false)] {
                                    material.alpha_mode = alpha_mode;
                                    material.double_sided = double_sided;
                                    material.premultiplied_alpha = premultiplied;
                                    material.alpha_cutoff = cutoff;
                                    material.shading_model = unlit;
                                    material.fog = fog;
                                    let packed = pack_instance(
                                        &[
                                            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                                            0.0, 0.0, 0.0, 0.0, 1.0,
                                        ],
                                        inverse_transpose3(
                                            &[
                                                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
                                                1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                                            ],
                                            1.0,
                                        ),
                                        &material,
                                        1.0,
                                        surface_flags(
                                            material.alpha_mode.unwrap_or(AlphaMode::Opaque),
                                            material.alpha_mode == Some(AlphaMode::Blend)
                                                && material.premultiplied_alpha.unwrap_or(false),
                                            material.double_sided.unwrap_or(false),
                                            receive,
                                            material.shading_model,
                                            material.fog,
                                        ),
                                    );
                                    assert_eq!(
                                        packed[31],
                                        recompute_surface_flags(&material, receive),
                                        "word 31 mismatch for {material:?} receive={receive:?}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
