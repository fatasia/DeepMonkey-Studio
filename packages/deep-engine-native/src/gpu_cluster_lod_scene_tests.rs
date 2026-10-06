//! 场景包 → `.dgc` 驻留摄入(场景级聚合)测试:双材质分节 + 绑定记录 + fail-closed。
//!
//! 金样字节 = `geometry_dag/tests/fixtures/quick_sphere.dgc.golden.json`
//! (dgc_byte_golden 入库字节,压缩/未压缩双档;`golden_variant` 复用
//! gpu_cluster_lod_dag_tests 的解析器,同一夹具零拷贝)。反例注入证明门咬人:
//! 损坏节回退不毒化其余节、重复节/空场景整体拒。

use crate::gpu_cluster_lod_dag_tests::golden_variant;
use crate::gpu_cluster_lod_scene::{
    ClusterLodSceneFallbackReason, ClusterLodSceneRuntime, ClusterLodSceneRuntimeError,
    ClusterLodSceneSectionInput,
};

fn section<'a>(geometry_id: &'a str, material_id: &'a str, dgc: &'a [u8]) -> ClusterLodSceneSectionInput<'a> {
    ClusterLodSceneSectionInput { geometry_id, material_id, dgc }
}

#[test]
fn dual_material_scene_ingests_both_sections_with_bindings() {
    let compressed = golden_variant("compressed");
    let uncompressed = golden_variant("uncompressed");
    let scene = ClusterLodSceneRuntime::from_sections([
        section("geom-frame", "mat-steel", &uncompressed),
        section("geom-panel", "mat-paint", &compressed),
    ])
    .expect("dual-material scene ingests");

    assert_eq!(scene.sections().len(), 2, "两个材质节全部摄入");
    assert!(scene.fallbacks().is_empty(), "无回退");
    let steel = scene.section_for("geom-frame", "mat-steel").expect("steel bound");
    assert_eq!(steel.dag.geometry_id, "geom-frame", "节 DAG 身份 = 几何身份(from_dgc 单节链)");
    assert_eq!(steel.material_id, "mat-steel", "材质实例绑定记录在节上");
    let paint = scene.section_for("geom-panel", "mat-paint").expect("paint bound");
    assert_eq!(paint.material_id, "mat-paint");
    assert_eq!(paint.dag.geometry_id, "geom-panel");
    assert!(scene.total_node_count() > 0, "节点总量为两节之和");
    assert_eq!(
        scene.total_node_count(),
        steel.dag.nodes.len() + paint.dag.nodes.len()
    );
    // 同一几何、不同材质 = 两个合法节(分节本意):绑定查找互不串扰。
    assert!(scene.section_for("geom-frame", "mat-paint").is_none());
}

#[test]
fn same_geometry_two_materials_is_two_sections() {
    let bytes = golden_variant("uncompressed");
    let scene = ClusterLodSceneRuntime::from_sections([
        section("geom-a", "mat-steel", &bytes),
        section("geom-a", "mat-paint", &bytes),
    ])
    .expect("same geometry two materials ingests");
    assert_eq!(scene.sections().len(), 2);
    assert_eq!(scene.section_for("geom-a", "mat-steel").unwrap().material_id, "mat-steel");
    assert_eq!(scene.section_for("geom-a", "mat-paint").unwrap().material_id, "mat-paint");
}

#[test]
fn corrupt_section_falls_back_without_poisoning_other_sections() {
    let mut corrupt = golden_variant("compressed");
    // 段 payload 区中部翻一字节:逐段 CRC32C 必咬,from_dgc 解析链失败。
    let victim = corrupt.len() / 2;
    corrupt[victim] ^= 0xff;
    let good = golden_variant("uncompressed");
    let scene = ClusterLodSceneRuntime::from_sections([
        section("geom-broken", "mat-glass", &corrupt),
        section("geom-good", "mat-steel", &good),
    ])
    .expect("混合场景仍整体摄入(失败节显式回退,不毒化)");

    assert_eq!(scene.sections().len(), 1, "仅好节驻留");
    assert_eq!(scene.sections()[0].dag.geometry_id, "geom-good");
    let fallbacks = scene.fallbacks();
    assert_eq!(fallbacks.len(), 1, "坏节显式回退,绝不静默");
    assert_eq!(fallbacks[0].geometry_id, "geom-broken");
    assert_eq!(fallbacks[0].material_id, "mat-glass");
    assert_eq!(fallbacks[0].reason, ClusterLodSceneFallbackReason::DgcParse);
    assert!(!fallbacks[0].detail.is_empty(), "回退细节如实上浮(from_dgc 透传理由)");
}

#[test]
fn truncated_section_falls_back_with_parse_reason() {
    let bytes = golden_variant("uncompressed");
    let scene = ClusterLodSceneRuntime::from_sections([
        section("geom-cut", "mat-steel", &bytes[..40]),
        section("geom-intact", "mat-paint", &bytes),
    ])
    .expect("截断节回退,整场景不拒");
    assert_eq!(scene.fallbacks().len(), 1);
    assert_eq!(scene.fallbacks()[0].reason, ClusterLodSceneFallbackReason::DgcParse);
    assert_eq!(scene.sections().len(), 1);
}

#[test]
fn duplicate_geometry_material_pair_rejects_whole_scene() {
    let bytes = golden_variant("uncompressed");
    let error = ClusterLodSceneRuntime::from_sections([
        section("geom-a", "mat-steel", &bytes),
        section("geom-a", "mat-steel", &bytes),
    ])
    .expect_err("重复 (geometry, material) 节 = 合同违约,整体 Err");
    assert_eq!(
        error,
        ClusterLodSceneRuntimeError::DuplicateSection {
            geometry_id: "geom-a".to_string(),
            material_id: "mat-steel".to_string(),
        }
    );
}

#[test]
fn contract_violations_reject_whole_scene() {
    let bytes = golden_variant("uncompressed");
    assert_eq!(
        ClusterLodSceneRuntime::from_sections([
            section("", "mat-steel", &bytes),
        ])
        .unwrap_err(),
        ClusterLodSceneRuntimeError::GeometryIdRequired
    );
    assert_eq!(
        ClusterLodSceneRuntime::from_sections([
            section("geom-a", "", &bytes),
        ])
        .unwrap_err(),
        ClusterLodSceneRuntimeError::MaterialIdRequired
    );
    assert_eq!(
        ClusterLodSceneRuntime::from_sections([] as [ClusterLodSceneSectionInput<'static>; 0]).unwrap_err(),
        ClusterLodSceneRuntimeError::EmptyScene
    );
}

#[test]
fn all_fallback_scene_reports_fallbacks_without_empty_scene_error() {
    let mut corrupt = golden_variant("uncompressed");
    corrupt[100] ^= 0x5a;
    let scene = ClusterLodSceneRuntime::from_sections([
        section("geom-only", "mat-steel", &corrupt),
    ])
    .expect("全回退场景仍产出(回退集如实上报,不算空场景)");
    assert!(scene.sections().is_empty());
    assert_eq!(scene.fallbacks().len(), 1);
    assert_eq!(scene.total_node_count(), 0);
}
