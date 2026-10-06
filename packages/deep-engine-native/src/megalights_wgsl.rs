//! B2 MegaLights RIS 采样核(WGSL 单源)的 Rust 宿主消费端。
//!
//! 唯一真源 = `packages/deep-engine/wgsl/megaLightsRis.wgsl`(与
//! [`crate::sdf_gi_wgsl`] / [`crate::probe_gi_wgsl`] 同一跨包 include_str! 惯例;
//! TS 半生成镜像 `megaLightsRisWgsl.ts` 与字节门禁
//! `megaLightsRisWgslChecksum.test.ts` 消费同一份文件与 `.sha256` 夹具——本模块
//! 补齐 Rust 半,两半同时绿 ⇔ 双端拿到的 WGSL 逐字节一致)。
//!
//! 核体语义:K=32 WRS 候选 + 时域蓄水池合并(深度门)+ 5×5 空间值域无偏平均
//! (法线/深度门)+ 胜者着色(deepMegaVisibilityAt 宿主注入);绑定留宿主模板
//! (TS `megaLightsRuntime.ts` 的 composeMegaLightsShader 组合;真机 GPU 探针
//! [`crate::megalights_gpu_probe_tests`] 用同款绑定面 dispatch)。
//! CPU 权威镜像与公式家族的逐式互钉见 [`crate::megalights_ris`]。

/// MegaLights RIS 采样核(只读直引,宿主侧供 GPU 探针测试与生产 dispatch 复用)。
pub const DEEP_MEGA_LIGHTS_RIS_WGSL: &str =
    include_str!("../../deep-engine/wgsl/megaLightsRis.wgsl");

/// compute 入口名(核内函数;宿主模板 entrypoint 调用,与 TS runtime 互钉)。
pub const DEEP_MEGA_BUILD_RESERVOIR_ENTRY: &str = "deepMegaBuildReservoir";
pub const DEEP_MEGA_REUSE_AND_SHADE_ENTRY: &str = "deepMegaReuseAndShade";

/// 解析 `<sha256-hex> <byte-len>` 单行校验和夹具(sdf_gi_wgsl 同式)。
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

/// 单源 WGSL ↔ 校验和夹具对拍(Rust 半;TS 半是 megaLightsRisWgslChecksum.test.ts)。
#[test]
fn shared_mega_lights_ris_wgsl_matches_pinned_checksum() {
    let (expected_checksum, expected_bytes) = parse_checksum(
        include_str!("../../deep-engine/wgsl/megaLightsRis.wgsl.sha256"),
        "megaLightsRis.wgsl",
    );
    assert_eq!(
        DEEP_MEGA_LIGHTS_RIS_WGSL.len(),
        expected_bytes,
        "megaLightsRis.wgsl 字节长度漂移"
    );
    assert_eq!(
        crate::shader_package::hash::sha256(DEEP_MEGA_LIGHTS_RIS_WGSL.as_bytes()),
        expected_checksum,
        "megaLightsRis.wgsl 内容漂移:改 .wgsl 必须同提交带上 wgsl:sync 再生成的镜像与夹具"
    );
}

/// 采样核合同自检:互钉常量/蓄水池结构/门值/穷举分支/宿主注入符号漂移即红
/// (与 TS megaLights.ts/megaLightsAbi.ts/megaLightsRisCpu.ts 词汇逐字对应)。
#[test]
fn mega_lights_ris_wgsl_contracts_stay_aligned() {
    let wgsl = DEEP_MEGA_LIGHTS_RIS_WGSL;
    // 互钉常量(与 crate::megalights_ris 同值;TS 半同款断言)。
    assert!(wgsl.contains("const DEEP_MEGA_LIGHT_STRIDE: u32 = 4u;"));
    assert!(wgsl.contains("const DEEP_MEGA_SURFACE_STRIDE: u32 = 3u;"));
    assert!(wgsl.contains("const DEEP_MEGA_KIND_POINT: u32 = 0u;"));
    assert!(wgsl.contains("const DEEP_MEGA_KIND_SPOT: u32 = 1u;"));
    assert!(wgsl.contains("const DEEP_MEGA_KIND_AREA_RECT: u32 = 2u;"));
    assert!(wgsl.contains("const DEEP_MEGA_RIS_CANDIDATES: u32 = 32u;"));
    assert!(wgsl.contains("const DEEP_MEGA_RIS_SPATIAL_RADIUS: u32 = 2u;"));
    assert!(wgsl.contains("const DEEP_MEGA_TEMPORAL_DEPTH_GATE: f32 = 0.1;"));
    assert!(wgsl.contains("const DEEP_MEGA_SPATIAL_NORMAL_GATE: f32 = 0.9;"));
    assert!(wgsl.contains("const DEEP_MEGA_INVALID: u32 = 0xffffffffu;"));
    // 蓄水池结构/合并公式/收尾公式(与 merge_reservoir/finish_reservoir 同式)。
    assert!(wgsl.contains("struct DeepMegaReservoir"));
    assert!(wgsl.contains("fn deepMegaReservoirMerge("));
    assert!(wgsl.contains("if (uniform * total < added) { (*reservoir).winner = winner; }"));
    assert!(wgsl.contains("f32(reservoir.winner + 1u)"), "winner 打包为 +1 的 f32(0=无效)");
    // 两趟入口与穷举分支(⑤ 退化一致性腿)。
    assert!(wgsl.contains(concat!("fn ", "deepMegaBuildReservoir", "(")));
    assert!(wgsl.contains(concat!("fn ", "deepMegaReuseAndShade", "(")));
    assert!(wgsl.contains("if (params.exhaustive != 0u)"));
    assert!(wgsl.contains("let candidates = select(DEEP_MEGA_RIS_CANDIDATES, lightCount, params.exhaustive != 0u);"));
    // 空间值域无偏平均(源像素评价 W_src;越界槽跳过)。
    assert!(wgsl.contains("let sourceWeight = f32(lightCount) * source.weightSum / (f32(source.m) * sourceTarget);"));
    assert!(wgsl.contains("deepMegaVisibilityAt(sourceIndex)"));
    // 胜者可见性与 IES 为宿主注入符号(模板组合;核内只消费)。
    assert!(wgsl.contains("deepMegaVisibilityAt(pixelIndex)"));
    assert!(wgsl.contains("deepSpotIesFactor(record.iesRow - 1u, surfaceToLight, record.direction)"));
    // 绑定留宿主模板:核体自身不得声明 @group(与 TS 半同款合同)。
    assert!(!wgsl.contains("@group("), "RIS 核绑定必须留宿主模板");
    assert!(!wgsl.contains("@compute"), "入口 entrypoint 属宿主模板");
}
