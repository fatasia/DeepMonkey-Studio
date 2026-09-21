//! C3 material/texture incremental classification.
//!
//! Uniform-only material changes can update the existing bind-group buffer in
//! place (stage 生成 rows → publish 原位 write_buffer);texture-slot、shader
//! feature、id、数量变化必须回落全量资源 staging。

use deep_engine_native::contract::PbrMaterial;
use deep_engine_native::pbr_texture::PreparedMaterial;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterialResourceDiff {
    Identical,
    UniformOnly { changed_indices: Vec<usize> },
    Structural,
}

pub fn classify_material_resources(
    before: &[PreparedMaterial],
    after: &[PreparedMaterial],
) -> MaterialResourceDiff {
    if before.len() != after.len() {
        return MaterialResourceDiff::Structural;
    }
    let mut changed = Vec::new();
    for (index, (old, new)) in before.iter().zip(after.iter()).enumerate() {
        // 材质 id 是批处理映射与实例引用的身份:换 id 即结构变化,即使
        // uniform 数值与纹理槽位全同也不允许原位覆写。
        if old.id != new.id
            || old.texture_indices != new.texture_indices
            || old.normal_mapped != new.normal_mapped
        {
            return MaterialResourceDiff::Structural;
        }
        if old.uniform != new.uniform {
            changed.push(index);
        }
    }
    if changed.is_empty() {
        MaterialResourceDiff::Identical
    } else {
        MaterialResourceDiff::UniformOnly {
            changed_indices: changed,
        }
    }
}

/// C3 uniform-only 快路径的第二道守卫(同族漏洞封堵):native ABI 里
/// base_color/metallic/roughness/alpha/emissive_factor/shading 等表面参数
/// **不在材质 uniform 里**,而是打包进实例缓冲词 24..36 与 surface flags
/// (见 `scene_pack::pack_instance`)。材质 uniform 分类对此不可见——若
/// 这些字段与 uv 变换同帧变化,只写 uniform 会静默丢掉实例词更新。
/// 因此进入 MaterialUniformRefresh 前,必须确认这些字段全同;任一不同
/// 回落全量路径(实例缓冲重建)。
pub fn instance_material_words_unchanged(before: &[PbrMaterial], after: &[PbrMaterial]) -> bool {
    if before.len() != after.len() {
        return false;
    }
    before.iter().zip(after.iter()).all(|(before, after)| {
        before.id == after.id
            && before.shading_model == after.shading_model
            && before.base_color == after.base_color
            && before.metallic == after.metallic
            && before.roughness == after.roughness
            && before.base_color_alpha == after.base_color_alpha
            && before.alpha_cutoff == after.alpha_cutoff
            && before.emissive_factor == after.emissive_factor
            && before.alpha_mode == after.alpha_mode
            && before.double_sided == after.double_sided
            && before.premultiplied_alpha == after.premultiplied_alpha
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use deep_engine_native::pbr_texture::PreparedMaterial;

    fn prepared(uniform: f32) -> PreparedMaterial {
        PreparedMaterial {
            id: "m".into(),
            normal_mapped: false,
            texture_indices: [None; 5],
            uniform: [uniform; 40],
        }
    }

    #[test]
    fn classifies_uniform_only_changes() {
        assert_eq!(
            classify_material_resources(&[prepared(0.0)], &[prepared(1.0)]),
            MaterialResourceDiff::UniformOnly {
                changed_indices: vec![0]
            }
        );
    }

    #[test]
    fn classifies_identical_and_structural() {
        assert_eq!(
            classify_material_resources(&[prepared(0.0)], &[prepared(0.0)]),
            MaterialResourceDiff::Identical
        );
        let mut changed = prepared(0.0);
        changed.texture_indices[0] = Some(2);
        assert_eq!(
            classify_material_resources(&[prepared(0.0)], &[changed]),
            MaterialResourceDiff::Structural
        );
    }

    #[test]
    fn classifies_id_swap_as_structural() {
        let mut swapped = prepared(0.0);
        swapped.id = "other".into();
        assert_eq!(
            classify_material_resources(&[prepared(0.0)], &[swapped]),
            MaterialResourceDiff::Structural
        );
    }

    #[test]
    fn classifies_count_change_as_structural() {
        assert_eq!(
            classify_material_resources(&[prepared(0.0)], &[prepared(0.0), prepared(1.0)]),
            MaterialResourceDiff::Structural
        );
    }

    fn contract_material(metallic: f32, offset: Option<[f32; 2]>) -> PbrMaterial {
        PbrMaterial {
            id: "m".into(),
            shading_model: None,
            base_color: [0.1, 0.2, 0.3],
            metallic,
            roughness: 0.6,
            base_color_texture: offset.map(|offset| deep_engine_native::contract::TextureSlot {
                texture: "t".into(),
                tex_coord: None,
                offset: Some(offset),
                scale: None,
                rotation: None,
            }),
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
        }
    }

    /// 实例词守卫:uv 变换变化放行,metallic/表面参数变化必须拦截。
    #[test]
    fn instance_word_guard_passes_uv_changes_and_blocks_surface_changes() {
        let base = contract_material(0.4, Some([0.0, 0.0]));
        let uv_moved = contract_material(0.4, Some([0.25, 0.0]));
        let metallic_moved = contract_material(0.9, Some([0.0, 0.0]));
        assert!(instance_material_words_unchanged(
            std::slice::from_ref(&base),
            &[uv_moved]
        ));
        assert!(!instance_material_words_unchanged(
            std::slice::from_ref(&base),
            &[metallic_moved]
        ));
        // 数量变化直接拦截。
        let doubled = [base.clone(), base.clone()];
        assert!(!instance_material_words_unchanged(
            std::slice::from_ref(&base),
            &doubled
        ));
    }

    /// C3 stage 快路径的 write 数据生成:classify 给出的 changed_indices
    /// 必须一一映射到 after 行的 uniform payload(publish 按 (index, payload)
    /// 原位写缓冲,不再重算)。
    #[test]
    fn uniform_rows_generation_follows_changed_indices() {
        use deep_engine_native::mesh_abi::MATERIAL_UNIFORM_FLOATS;
        let before = vec![prepared(0.0), prepared(1.0), prepared(2.0)];
        let mut after = before.clone();
        after[0].uniform[7] = 9.0;
        after[2].uniform[7] = -3.0;
        let rows: Vec<(usize, [f32; MATERIAL_UNIFORM_FLOATS])> =
            match classify_material_resources(&before, &after) {
                MaterialResourceDiff::UniformOnly { changed_indices } => changed_indices
                    .iter()
                    .map(|&index| (index, after[index].uniform))
                    .collect(),
                other => panic!("expected UniformOnly, got {other:?}"),
            };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, 0);
        assert_eq!(rows[0].1, after[0].uniform);
        assert_eq!(rows[1].0, 2);
        assert_eq!(rows[1].1, after[2].uniform);
    }
}
