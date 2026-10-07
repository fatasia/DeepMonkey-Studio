//! megaLights RIS 生产帧接线的 CPU 测试:门控词汇/视空间变换/灯池构建与打包/
//! 直射通路决策/IES 行重映射寻址合同(含 factor 求值等价)/可见性 fail-closed。

use super::*;
use deep_engine_native::local_lighting::LocalLight;
use deep_engine_native::megalights_ies::evaluate_ies_shading_factor;
use deep_engine_native::megalights_ris::{DirectLightingPath, DirectLightingPathReason};
use deep_engine_native::runtime_package::{LightIes, LightProfile};

fn lighting_with(lights: Vec<LocalLight>) -> DirectionalLighting {
    let mut local = std::array::from_fn(|_| LocalLight::default());
    for (index, light) in lights.into_iter().enumerate() {
        local[index] = light;
    }
    DirectionalLighting {
        direction: [0.0, 1.0, 0.0],
        radiance: [1.0, 1.0, 1.0],
        exposure: 1.0,
        shadows: false,
        global_illumination_intensity: None,
        local_lights: local,
        light_profiles: None,
    }
}

fn point_light(position: [f32; 3], radiance: [f32; 3]) -> LocalLight {
    LocalLight {
        kind: LocalLightKind::Point,
        position,
        direction: [0.0, 1.0, 0.0],
        radiance,
        range: 10.0,
        decay: 2.0,
        inner_cos: 1.0,
        outer_cos: -1.0,
        ..LocalLight::default()
    }
}

fn spot_light(position: [f32; 3], direction: [f32; 3], ies: Option<LightIes>) -> LocalLight {
    LocalLight {
        kind: LocalLightKind::Spot,
        position,
        direction,
        radiance: [2.0, 2.0, 2.0],
        range: 12.0,
        decay: 2.0,
        inner_cos: 0.9,
        outer_cos: 0.6,
        ies,
        ..LocalLight::default()
    }
}

/// 相机:原点环视 target原点,distance 4,yaw/pitch 0 → forward = (0,0,−1)。
fn view() -> PlayerView {
    PlayerView {
        yaw: 0.0,
        pitch: 0.0,
        ..PlayerView::default()
    }
}

#[test]
fn gate_parse_defaults_closed() {
    assert_eq!(parse_megalights_gate(None), MegaLightsGate::Off);
    assert_eq!(parse_megalights_gate(Some("0")), MegaLightsGate::Off);
    assert_eq!(parse_megalights_gate(Some("off")), MegaLightsGate::Off);
    assert_eq!(parse_megalights_gate(Some("junk")), MegaLightsGate::Off);
    assert_eq!(parse_megalights_gate(Some("auto")), MegaLightsGate::Auto);
    assert_eq!(parse_megalights_gate(Some("FORCE")), MegaLightsGate::Force);
    assert_eq!(parse_megalights_gate(Some("on")), MegaLightsGate::Force);
}

#[test]
fn to_view_matches_lookat_contract() {
    // forward = (0,0,−1),eye = (0,0,4)。target 原点在视空间 (0,0,−4)(z=−depth)。
    assert_eq!(to_view(view(), [0.0, 0.0, 0.0], true), [0.0, 0.0, -4.0]);
    // 方向不带平移:−z 方向光轴 → 视空间 (0,0,−1)。
    assert_eq!(to_view(view(), [0.0, 0.0, -1.0], false), [0.0, 0.0, -1.0]);
    // +x 侧偏:视空间 x = right·d。
    assert_eq!(to_view(view(), [2.0, 0.0, 0.0], true)[0], 2.0);
}

#[test]
fn pool_counts_and_view_space_build() {
    let lighting = lighting_with(vec![
        point_light([0.0, 0.0, -5.0], [1.0, 2.0, 3.0]),
        spot_light([0.0, 0.0, -5.0], [0.0, 0.0, -1.0], None),
        LocalLight {
            kind: LocalLightKind::Hemisphere,
            ground_radiance: Some([0.0; 3]),
            ..LocalLight::default()
        },
        LocalLight {
            kind: LocalLightKind::Directional,
            ..LocalLight::default()
        },
        LocalLight::default(), // Disabled
    ]);
    assert_eq!(count_pool_lights(&lighting), (1, 1));
    let pool = build_view_space_pool(&lighting, view(), false);
    assert_eq!(pool.len(), 2);
    // 点光:世界 (0,0,−5) → 视空间 z = −9(eye z=4,d=−9,−forward·d=−9)。
    assert_eq!(pool[0].kind, MegaLightKind::Point);
    assert_eq!(pool[0].position_view, [0.0, 0.0, -9.0]);
    assert_eq!(pool[0].color, [1.0, 2.0, 3.0]);
    assert_eq!(pool[0].intensity, 1.0);
    // 聚光:方向 (0,0,−1) → 视空间 (0,0,−1);锥角直传(f32 词面经 f64 承载)。
    assert_eq!(pool[1].kind, MegaLightKind::Spot);
    assert_eq!(pool[1].direction_view, [0.0, 0.0, -1.0]);
    assert_eq!(pool[1].inner_cone_cos, f64::from(0.9f32));
    assert_eq!(pool[1].outer_cone_cos, f64::from(0.6f32));
    // 灯池可打包(64B/灯 ABI)。
    let packed = pack_mega_lights(&pool);
    assert_eq!(packed.count, 2);
    assert_eq!(packed.data.len(), 2 * 16);
}

#[test]
fn decision_follows_gate_and_budget() {
    let lighting = lighting_with(vec![
        point_light([0.0; 3], [1.0; 3]),
        spot_light([0.0; 3], [0.0, 1.0, 0.0], None),
    ]);
    // force = RIS(MegalightsForced),auto = 2 ≤ 16 恒簇光(零回归)。
    let forced = MegaLightsFrameRuntime::build(&lighting, MegaLightsGate::Force, None, false);
    assert_eq!(
        forced.telemetry().decision.path,
        DirectLightingPath::MegalightsRis
    );
    assert_eq!(
        forced.telemetry().decision.reason,
        DirectLightingPathReason::MegalightsForced
    );
    assert_eq!(
        forced.telemetry().execution_leg,
        MegaLightsExecutionLeg::PendingRealMachineGate
    );
    let auto = MegaLightsFrameRuntime::build(&lighting, MegaLightsGate::Auto, None, false);
    assert_eq!(
        auto.telemetry().decision.path,
        DirectLightingPath::ClusterForwardPlus
    );
    assert_eq!(
        auto.telemetry().decision.reason,
        DirectLightingPathReason::WithinClusterBudget
    );
    // 可见性档位 fail-closed:无 TLAS = Off。
    assert_eq!(
        auto.telemetry().visibility_source,
        MegaLightsVisibilitySource::Off
    );
    let resident = MegaLightsFrameRuntime::build(&lighting, MegaLightsGate::Auto, None, true);
    assert_eq!(
        resident.telemetry().visibility_source,
        MegaLightsVisibilitySource::TlasResident
    );
}

#[test]
fn advance_refreshes_decision_pool_and_frames() {
    let lighting = lighting_with(vec![point_light([1.0, 2.0, 3.0], [1.0; 3])]);
    let mut runtime = MegaLightsFrameRuntime::build(&lighting, MegaLightsGate::Force, None, false);
    runtime.advance(view(), Some(&lighting), false);
    let telemetry = runtime.telemetry();
    assert_eq!(telemetry.frame_index, 1);
    assert_eq!(telemetry.pool_count, 1);
    assert_eq!(runtime.packed.as_ref().expect("packed").count, 1);
    // 无照明内容:帧推进短路,状态不动。
    runtime.advance(view(), None, true);
    assert_eq!(runtime.telemetry().frame_index, 1);
    assert_eq!(
        runtime.telemetry().visibility_source,
        MegaLightsVisibilitySource::Off
    );
}

/// 合成 IES 存储(与 `NativeIesShadingResource::prepare` 打包公式一致):
/// 16 灯槽行(槽 1 = spot,metaBase = 16 + profile 序)+ 1 元数据行
/// (tableBase = 16 + profile 数)+ 2 表行。
fn ies_storage_rows() -> Vec<[f32; 4]> {
    let mut rows = vec![[-1.0f32, 0.0, 0.0, 0.0]; 16];
    rows[1] = [0.0, 40.0, 1.5, 16.0]; // profile 0 / 旋转半度 40 / 缩放 1.5 / metaBase=16
    rows.push([17.0, 2.0, 90.0, 1.0]); // 元数据:tableBase=17 / 2 行 / 半步 90° / 对称 1
    rows.push([1.0, 2.0, 3.0, 4.0]); // 表行 0
    rows.push([5.0, 6.0, 7.0, 8.0]); // 表行 1
    rows
}

fn profile() -> LightProfile {
    LightProfile {
        profile_id: "p0".into(),
        format: "LM-63-1995".into(),
        vertical_angles: vec![0.0, 90.0],
        candela: vec![vec![1.0], vec![1.0]],
        horizontal_symmetry: 1,
        total_lumens: 0.0,
    }
}

#[test]
fn ies_remap_rebases_metadata_and_tables() {
    let ies = LightIes {
        profile_id: "p0".into(),
        rotation_deg: Some(20.0),
        scale_factor: Some(1.5),
    };
    let lighting = lighting_with(vec![
        point_light([0.0; 3], [1.0; 3]),
        spot_light([0.0; 3], [0.0, 1.0, 0.0], Some(ies)),
    ]);
    let mut lighting = lighting;
    lighting.light_profiles = Some(vec![profile()]);
    let rows = ies_storage_rows();
    let (words, spot_count) =
        remap_ies_spot_rows(&lighting, Some(rows.as_slice())).expect("remap succeeds");
    assert_eq!(spot_count, 1);
    // spot 行 = 槽行 4 词,metaBase 重定基 = spotCount + profileIndex = 1。
    assert_eq!(&words[0..4], &[0.0, 40.0, 1.5, 1.0]);
    // 元数据行 tableBase 重定基 = spotCount + (17 − 16) = 2;其余词逐字。
    assert_eq!(&words[4..8], &[2.0, 2.0, 90.0, 1.0]);
    // 表行逐字拷贝。
    assert_eq!(&words[8..12], &[1.0, 2.0, 3.0, 4.0]);
    assert_eq!(&words[12..16], &[5.0, 6.0, 7.0, 8.0]);
    // 寻址合同:重映射载荷与 TS 式手工紧凑打包逐词一致,且 factor 求值相等。
    let reference_words = vec![
        0.0f32, 40.0, 1.5, 1.0, // spot 行
        2.0, 2.0, 90.0, 1.0, // 元数据行(tableBase=2)
        1.0, 2.0, 3.0, 4.0, // 表行 0
        5.0, 6.0, 7.0, 8.0, // 表行 1
    ];
    assert_eq!(
        words, reference_words,
        "重映射载荷 = TS packIesShading 紧凑布局"
    );
    let remapped = MegaLightsIesPacking::new(&words, 1);
    let reference = MegaLightsIesPacking::new(&reference_words, 1);
    for probe_direction in [
        [0.0f64, 0.0, -1.0],
        [0.5, -0.5, -0.7071067811865476],
        [-0.3, 0.2, -0.9327379053088816],
    ] {
        let surface_to_light = [0.0, 1.0, 0.0];
        assert_eq!(
            evaluate_ies_shading_factor(&remapped, 0, probe_direction, surface_to_light),
            evaluate_ies_shading_factor(&reference, 0, probe_direction, surface_to_light),
        );
    }
}

#[test]
fn ies_remap_fail_closed() {
    let ies = LightIes {
        profile_id: "p0".into(),
        rotation_deg: None,
        scale_factor: None,
    };
    let mut lighting = lighting_with(vec![spot_light([0.0; 3], [0.0, 1.0, 0.0], Some(ies))]);
    lighting.light_profiles = Some(vec![profile()]);
    // 无存储行 → None。
    assert_eq!(remap_ies_spot_rows(&lighting, None), None);
    // 存储行只有灯槽节(≤16)→ None。
    assert_eq!(
        remap_ies_spot_rows(&lighting, Some(&vec![[-1.0; 4]; 16])),
        None
    );
    // 槽行缺省(-1)= 打包侧未登记 → None。
    assert_eq!(
        remap_ies_spot_rows(&lighting, Some(&vec![[-1.0f32; 4]; 17])),
        None
    );
    // profile 未声明 → None。
    let mut orphan = lighting.clone();
    orphan.light_profiles = Some(Vec::new());
    assert_eq!(
        remap_ies_spot_rows(&orphan, Some(&ies_storage_rows())),
        None
    );
    // 无 IES spot → None(不建载荷)。
    let plain = lighting_with(vec![spot_light([0.0; 3], [0.0, 1.0, 0.0], None)]);
    assert_eq!(remap_ies_spot_rows(&plain, Some(&ies_storage_rows())), None);
}

#[test]
fn runtime_ies_ordinals_reach_the_pool() {
    let ies = LightIes {
        profile_id: "p0".into(),
        rotation_deg: None,
        scale_factor: None,
    };
    let mut lighting = lighting_with(vec![
        point_light([9.0; 3], [1.0; 3]),
        spot_light([0.0; 3], [0.0, 1.0, 0.0], Some(ies)),
        spot_light([1.0; 3], [0.0, 1.0, 0.0], None),
    ]);
    lighting.light_profiles = Some(vec![profile()]);
    let runtime = MegaLightsFrameRuntime::build(
        &lighting,
        MegaLightsGate::Force,
        Some(ies_storage_rows().as_slice()),
        false,
    );
    assert_eq!(runtime.telemetry().ies_spot_count, 1);
    assert!(runtime.ies_packing().is_some());
    let mut live = runtime;
    live.advance(view(), Some(&lighting), false);
    let pool = &live.pool;
    // 池序 = 灯槽序过滤点/聚:pool[0] = 点光(槽 0),pool[1] = IES 聚光(槽 1)。
    assert_eq!(pool[0].kind, MegaLightKind::Point);
    assert_eq!(
        pool[1].ies_spot_index,
        Some(0),
        "携带 IES 的聚光获得池序行号"
    );
    assert_eq!(pool[2].ies_spot_index, None, "无 IES 聚光恒 1 因子");
}
