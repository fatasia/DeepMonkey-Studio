//! F2 RT 驻留切片：纯计划核单测（不触 device）。
//!
//! 覆盖：同几何 BLAS 去重、BLEND 整族排除、MASK 保守包含、零三角几何排除、
//! 实例数/三角形预算 fail-closed、空场景拒绝、变换与 custom_index 保真。
//! 这些是不依赖 GPU 的合同；真机构建由 `hardware_ray_query` 的定向 GPU 测试覆盖。

use deep_engine_native::contract::AlphaMode;
use deep_engine_native::scene::{DrawBatch, PackedInstance};

use crate::renderer::rt_residency::{
    classify_rt_batches, plan_rt_scene, RtResidencyReject, RtScenePlan,
    RT_MAX_BLAS_TRIANGLES, RT_MAX_INSTANCES,
};

/// 3x4 行主序模型矩阵：平移 + 均匀缩放，便于断言变换保真。
fn model(scale: f32, tx: f32) -> [f32; 12] {
    [scale, 0.0, 0.0, tx, 0.0, scale, 0.0, 0.0, 0.0, 0.0, scale, 0.0]
}

fn packed_row(scale: f32, tx: f32) -> PackedInstance {
    // PackedInstance 是 36 float 的实例行；前 12 词即行主序 3x4 模型矩阵
    // （scene::recompute_transform_update 布局），其余为材质/标志位，本核不读。
    let mut row = [0.0f32; deep_engine_native::mesh_abi::PACKED_INSTANCE_FLOATS];
    row[..12].copy_from_slice(&model(scale, tx));
    row
}

fn batch(geometry_index: usize, instance_start: u32, instance_count: u32,
    alpha_mode: AlphaMode) -> DrawBatch {
    DrawBatch {
        lod: false,
        cast_shadow: true,
        geometry_index,
        material_index: 0,
        mirrored: false,
        double_sided: false,
        alpha_mode,
        premultiplied: false,
        sort_center: None,
        stable_order: 0,
        instance_start,
        instance_count,
    }
}

#[test]
fn plan_dedupes_blas_per_geometry_and_keeps_instance_order() {
    // 两个几何：几何 0 被 3 个实例引用（同一几何只建一份 BLAS），几何 1 一个实例。
    let geometries = [(8u32, 36u32), (4, 6)];
    let instances = vec![
        (0usize, 0u32, model(1.0, 0.0)),
        (0, 1, model(1.0, 5.0)),
        (1, 2, model(2.0, 0.0)),
        (0, 3, model(1.0, -5.0)),
    ];
    let plan = plan_rt_scene(&geometries, &instances).expect("valid plan");
    assert_eq!(plan.geometries.len(), 2, "one BLAS per distinct geometry");
    assert_eq!(plan.geometries[0].geometry_index, 0);
    assert_eq!(plan.geometries[1].geometry_index, 1);
    // 前三个几何 0 实例共享 slot 0，几何 1 用 slot 1，第四个回到 slot 0。
    assert_eq!(plan.instances.iter().map(|i| i.blas_slot).collect::<Vec<_>>(),
        vec![0, 0, 1, 0]);
    // custom_index 与打包行号一致，供像素消费者回查材质。
    assert_eq!(plan.instances.iter().map(|i| i.custom_index).collect::<Vec<_>>(),
        vec![0, 1, 2, 3]);
    // 变换逐值保真（不做归一化/重排）。
    assert_eq!(plan.instances[1].transform, model(1.0, 5.0));
    assert_eq!(plan.instances[2].transform, model(2.0, 0.0));
    // 三角形总数按去重后的几何计，不按实例数放大。
    assert_eq!(plan.triangles, 12 + 2);
}

#[test]
fn plan_rejects_empty_scene_instead_of_building_an_empty_tlas() {
    let plan = plan_rt_scene(&[(8, 36)], &[]);
    assert_eq!(plan, Err(RtResidencyReject::EmptyScene));
}

#[test]
fn plan_excludes_zero_triangle_geometry_and_counts_it() {
    // 几何 0 有三角，几何 1 为空（0 索引）——空几何实例被排除并计数，
    // 不产生零三角 BLAS（BLAS 构建会拒绝空几何）。
    let geometries = [(8u32, 36u32), (4, 0)];
    let instances = vec![
        (0usize, 0u32, model(1.0, 0.0)),
        (1, 1, model(1.0, 2.0)),
    ];
    let plan = plan_rt_scene(&geometries, &instances).expect("valid plan");
    assert_eq!(plan.instances.len(), 1);
    assert_eq!(plan.geometries.len(), 1);
    assert_eq!(plan.excluded_empty_geometry_instances, 1);
}

#[test]
fn plan_rejects_unknown_geometry_reference() {
    let plan = plan_rt_scene(&[(8, 36)], &[(7usize, 0u32, model(1.0, 0.0))]);
    assert_eq!(plan, Err(RtResidencyReject::GeometryInvalid));
}

#[test]
fn plan_fails_closed_when_a_geometry_exceeds_the_blas_triangle_budget() {
    // 单几何三角形数超过 Web RayBackend 同源预算：整体拒绝，不部分驻留。
    let too_many = (RT_MAX_BLAS_TRIANGLES + 3) as u32 * 3;
    let plan = plan_rt_scene(&[(4, too_many)], &[(0usize, 0u32, model(1.0, 0.0))]);
    assert_eq!(plan, Err(RtResidencyReject::BudgetExceeded));
    assert_eq!(RtResidencyReject::BudgetExceeded.reason(), "tlas_budget_exceeded");
}

#[test]
fn plan_fails_closed_when_instance_count_exceeds_the_budget() {
    let geometries = [(8u32, 36u32)];
    let instances: Vec<(usize, u32, [f32; 12])> = (0..=(RT_MAX_INSTANCES as u32))
        .map(|row| (0usize, row, model(1.0, row as f32)))
        .collect();
    assert_eq!(plan_rt_scene(&geometries, &instances), Err(RtResidencyReject::BudgetExceeded));
}

#[test]
fn classify_excludes_blend_batches_and_keeps_mask_conservatively() {
    // 三个批次：opaque(2) / blend(3) / mask(1)。BLEND 整族排除（最近命中 ABI
    // 没有 any-hit alpha continuation）；MASK 保守包含并单独计数。
    let packed = vec![
        packed_row(1.0, 0.0), packed_row(1.0, 1.0),
        packed_row(1.0, 2.0), packed_row(1.0, 3.0), packed_row(1.0, 4.0),
        packed_row(1.0, 5.0),
    ];
    let batches = vec![
        batch(0, 0, 2, AlphaMode::Opaque),
        batch(0, 2, 3, AlphaMode::Blend),
        batch(0, 5, 1, AlphaMode::Mask),
    ];
    let (classified, excluded_blend, conservative_mask) =
        classify_rt_batches(&batches, &packed);
    assert_eq!(excluded_blend, 3);
    assert_eq!(conservative_mask, 1);
    assert_eq!(classified.len(), 3, "opaque 2 + mask 1 stay resident");
    // 排除的实例不进入候选：行号是 0,1,5，不含 2..4。
    assert_eq!(classified.iter().map(|(_, row, _)| *row).collect::<Vec<_>>(),
        vec![0, 1, 5]);
    // 变换取自 packed 行的前 12 词。
    assert_eq!(classified[2].2, model(1.0, 5.0));
}

#[test]
fn classify_yields_empty_candidates_for_an_all_blend_scene() {
    let packed = vec![packed_row(1.0, 0.0), packed_row(1.0, 1.0)];
    let batches = vec![batch(0, 0, 2, AlphaMode::Blend)];
    let (classified, excluded, mask) = classify_rt_batches(&batches, &packed);
    assert!(classified.is_empty());
    assert_eq!(excluded, 2);
    assert_eq!(mask, 0);
    // 全 BLEND 场景经计划核后必须 fail-closed 为空场景，而不是驻留空 TLAS。
    let plan = plan_rt_scene(&[(8, 36)], &classified);
    assert_eq!(plan, Err(RtResidencyReject::EmptyScene));
}

#[test]
fn reject_reasons_are_machine_readable_and_distinct() {
    let reasons = [
        RtResidencyReject::MissingFeature.reason(),
        RtResidencyReject::EmptyScene.reason(),
        RtResidencyReject::BudgetExceeded.reason(),
        RtResidencyReject::GeometryInvalid.reason(),
    ];
    let unique: std::collections::BTreeSet<_> = reasons.iter().collect();
    assert_eq!(unique.len(), reasons.len(), "each rejection keeps its own reason string");
    assert_eq!(RtResidencyReject::MissingFeature.reason(), "adapter_feature_unavailable");
    assert_eq!(RtResidencyReject::EmptyScene.reason(), "tlas_no_resident_instances");
    assert_eq!(RtResidencyReject::GeometryInvalid.reason(), "tlas_geometry_rejected");
}

#[test]
fn plan_keeps_triangle_total_bounded_by_resident_geometry() {
    let geometries = [(8u32, 36u32), (4, 9)];
    let instances = vec![
        (0usize, 0u32, model(1.0, 0.0)),
        (1, 1, model(1.0, 1.0)),
    ];
    let plan: RtScenePlan = plan_rt_scene(&geometries, &instances).expect("valid plan");
    assert_eq!(plan.triangles, 12 + 3);
    assert_eq!(plan.excluded_blend_instances, 0);
    assert_eq!(plan.conservative_mask_instances, 0);
}
