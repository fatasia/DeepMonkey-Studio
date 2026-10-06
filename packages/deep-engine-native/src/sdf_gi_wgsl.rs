//! Brief-GI WGSL 单源(sdf-gi 域)的 Rust 宿主消费端。
//!
//! 唯一真源 = `packages/deep-engine/wgsl/` 下三个 sdf-gi 计算核(与
//! `probe_gi_wgsl.rs` 的 probeClipmapSampling 同一跨包 include_str! 惯例):
//! - `sdfSkyVisibilityTrace.wgsl` —— 天光圆锥追踪核(烘焙距离场 → 可见度+命中距离);
//! - `sdfGiProbeUpdate.wgsl` —— 探针 SH 更新核(96B 记录行读写,F5 words[12..23] 不动);
//! - `sdfBakeSceneGrid.wgsl` —— 场景距离场 compute 烘焙核(距离 min + 奇偶定号)。
//!
//! 双端逐字节一致性对拍:每个 `.wgsl.sha256` 夹具(`<sha256-hex> <byte-len>` 单行),
//! TS 半在 `deep-engine/src/gi/*WgslChecksum.test.ts`(此前「无 Rust 半,纯 TS 消费」,
//! 本模块补齐 Rust 半 —— 两半同时绿 ⇔ 双端拿到的 WGSL 逐字节一致)。修改 WGSL 的
//! 流程:改 `.wgsl` → `pnpm --filter @bim-studio/deep-engine wgsl:sync` → 同一提交
//! 带上重新生成的镜像与夹具(任一侧不同步,两半测试都会失败)。
//!
//! 与既有骨架的关系:96B 记录行布局与 [`crate::probe_gi_abi`] 逐字对齐;
//! SkyTraceParams/ProbeUpdateParams uniform 布局与
//! [`crate::sdf_gi_trace::SdfSkyTraceParams`]/[`crate::sdf_gi_probe_update::
//! SdfGiProbeUpdateParams`] 互钉。

/// 天光圆锥追踪核(只读直引,宿主侧供 GPU 探针测试与生产 dispatch 复用)。
pub const DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL: &str =
    include_str!("../../deep-engine/wgsl/sdfSkyVisibilityTrace.wgsl");
/// 探针 SH 更新核。
pub const DEEP_SDF_GI_PROBE_UPDATE_WGSL: &str =
    include_str!("../../deep-engine/wgsl/sdfGiProbeUpdate.wgsl");
/// 场景距离场 compute 烘焙核。
pub const DEEP_SDF_BAKE_SCENE_GRID_WGSL: &str =
    include_str!("../../deep-engine/wgsl/sdfBakeSceneGrid.wgsl");

/// compute 入口名(与 TS `SDF_SKY_VISIBILITY_ENTRY` 互钉)。
pub const SDF_SKY_VISIBILITY_ENTRY: &str = "traceSkyVisibility";
/// compute 入口名(与 TS `SDF_GI_PROBE_UPDATE_ENTRY` 互钉)。
pub const SDF_GI_PROBE_UPDATE_ENTRY: &str = "sdfGiProbeUpdateMain";
/// compute 入口名(与 TS `SDF_BAKE_SCENE_GRID_ENTRY` 互钉)。
pub const SDF_BAKE_SCENE_GRID_ENTRY: &str = "sdfBakeSceneGridMain";

/// 解析 `<sha256-hex> <byte-len>` 单行校验和夹具。
#[cfg(test)]
fn parse_checksum(fixture: &str, label: &str) -> (String, usize) {
    let mut fields = fixture.split_whitespace();
    let checksum = fields
        .next()
        .unwrap_or_else(|| panic!("{label} 夹具缺 sha256 hex"));
    let bytes: usize = fields
        .next()
        .unwrap_or_else(|| panic!("{label} 夹具缺字节长度"))
        .parse()
        .unwrap_or_else(|error| panic!("{label} 夹具字节长度必须是 usize:{error}"));
    assert_eq!(checksum.len(), 64, "{label} 夹具必须持 64 位 sha256 hex");
    (checksum.to_string(), bytes)
}

/// 单源 WGSL ↔ 校验和夹具对拍(Rust 半;TS 半是同名 *WgslChecksum.test.ts)。
macro_rules! wgsl_checksum_test {
    ($test_name:ident, $source:expr, $fixture:expr, $label:literal) => {
        #[test]
        fn $test_name() {
            let (expected_checksum, expected_bytes) = parse_checksum($fixture, $label);
            assert_eq!($source.len(), expected_bytes, "{} 字节长度漂移", $label);
            assert_eq!(
                crate::shader_package::hash::sha256($source.as_bytes()),
                expected_checksum,
                "{} 内容漂移:改 .wgsl 必须同提交带上 wgsl:sync 再生成的镜像与夹具",
                $label
            );
        }
    };
}

wgsl_checksum_test!(
    shared_sky_visibility_trace_wgsl_matches_pinned_checksum,
    DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL,
    include_str!("../../deep-engine/wgsl/sdfSkyVisibilityTrace.wgsl.sha256"),
    "sdfSkyVisibilityTrace.wgsl"
);
wgsl_checksum_test!(
    shared_sdf_gi_probe_update_wgsl_matches_pinned_checksum,
    DEEP_SDF_GI_PROBE_UPDATE_WGSL,
    include_str!("../../deep-engine/wgsl/sdfGiProbeUpdate.wgsl.sha256"),
    "sdfGiProbeUpdate.wgsl"
);
wgsl_checksum_test!(
    shared_sdf_bake_scene_grid_wgsl_matches_pinned_checksum,
    DEEP_SDF_BAKE_SCENE_GRID_WGSL,
    include_str!("../../deep-engine/wgsl/sdfBakeSceneGrid.wgsl.sha256"),
    "sdfBakeSceneGrid.wgsl"
);

/// 三个核的合同自检:入口名/绑定面/96B 记录行步长漂移即红(与 TS 打包侧互钉)。
#[test]
fn sdf_gi_wgsl_contracts_stay_aligned() {
    assert!(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL.contains("@compute @workgroup_size(64)"));
    assert!(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL.contains("fn traceSkyVisibility("));
    assert!(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL.contains("visibilities[lane] = visibility;"));
    assert!(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL.contains("hitDistances[lane] = hitDistance;"));

    assert!(DEEP_SDF_GI_PROBE_UPDATE_WGSL.contains("fn sdfGiProbeUpdateMain("));
    // F5 合同:更新核绝不写 vec4[3..5](RGB L1 SH 方向可见度)。
    assert!(DEEP_SDF_GI_PROBE_UPDATE_WGSL.contains("records[base] = vec4f(blended, current.w);"));
    assert!(
        DEEP_SDF_GI_PROBE_UPDATE_WGSL
            .contains("records[base + 1u] = vec4f(meanDistance, variance, c0 / n, 0.0);")
    );
    assert!(!DEEP_SDF_GI_PROBE_UPDATE_WGSL.contains("records[base + 3u]"));

    assert!(DEEP_SDF_BAKE_SCENE_GRID_WGSL.contains("fn sdfBakeSceneGridMain("));
    assert!(DEEP_SDF_BAKE_SCENE_GRID_WGSL.contains("field[linear] = sign * nearest;"));
}
