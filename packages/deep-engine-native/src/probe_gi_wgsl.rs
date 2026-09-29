//! F5 WGSL 单源(试点):探针 GI 采样库的 Rust 宿主消费端。
//!
//! 唯一真源是 `packages/deep-engine/wgsl/probeClipmapSampling.wgsl`:
//! - TS 侧由 `deep-engine/src/lighting/probeClipmapSamplingWgsl.ts`(生成镜像,
//!   由 `deep-engine/scripts/syncSharedWgsl.mjs` 逐字节转写)消费;
//! - 本模块经 `include_str!` 直接引用同一文件(仓内惯例:相对字面量路径,
//!   与 `../assets/shaders/*.wgsl` 同一形式;跨包路径依赖 packages/ 兄弟目录布局,
//!   由本模块对拍测试守护)。
//!
//! 双端逐字节一致性对拍:共享校验和夹具
//! `packages/deep-engine/wgsl/probeClipmapSampling.wgsl.sha256`(`<sha256-hex> <byte-len>` 单行),
//! TS 半在 `deep-engine/src/lighting/probeClipmapSamplingWgslChecksum.test.ts`、
//! Rust 半在下方 `shared_wgsl_matches_pinned_checksum`。两半同时绿 ⇔ 双端拿到的 WGSL 逐字节一致。
//! 修改 WGSL 的流程:改 `.wgsl` → `pnpm --filter @bim-studio/deep-engine wgsl:sync`
//! → 同一提交带上重新生成的镜像与夹具(任一侧不同步,两半测试都会失败)。
//!
//! 与 `probe_gi_abi` 的关系:96B 记录布局与 group-3 绑定号必须保持一致;
//! 绑定号/预算常量在 TS 侧由字节门禁测试与 WGSL 字面量互相锁定。

/// F5 探针 GI 存储采样库(group-3 只读;记录布局与 web `packIrradianceProbeRecord` 96B ABI 对齐)。
pub const PROBE_CLIPMAP_SAMPLING_WGSL: &str =
    include_str!("../../deep-engine/wgsl/probeClipmapSampling.wgsl");

#[cfg(test)]
mod tests {
    use super::PROBE_CLIPMAP_SAMPLING_WGSL;

    #[test]
    fn shared_wgsl_matches_pinned_checksum() {
        let fixture = include_str!("../../deep-engine/wgsl/probeClipmapSampling.wgsl.sha256");
        let mut fields = fixture.split_whitespace();
        let expected_checksum = fields.next().expect("checksum fixture missing sha256 hex");
        let expected_bytes: usize = fields
            .next()
            .expect("checksum fixture missing byte length")
            .parse()
            .expect("checksum fixture byte length must be a usize");
        assert_eq!(expected_checksum.len(), 64, "fixture must hold a sha256 hex digest");
        assert_eq!(PROBE_CLIPMAP_SAMPLING_WGSL.len(), expected_bytes);
        assert_eq!(
            crate::shader_package::hash::sha256(PROBE_CLIPMAP_SAMPLING_WGSL.as_bytes()),
            expected_checksum,
        );
    }

    #[test]
    fn shared_wgsl_keeps_group3_bindings_aligned_with_probe_gi_abi() {
        // 绑定号与 probe_gi_abi/probe_gi_storage 的合同一致(sampling 绑定组 3,记录为只读 storage);
        // 若 WGSL 单源被改动导致绑定漂移,必须在同一提交里同步 probe_gi_storage 的绑定合同。
        assert!(PROBE_CLIPMAP_SAMPLING_WGSL.contains("@group(3) @binding(9)"));
        assert!(PROBE_CLIPMAP_SAMPLING_WGSL.contains("var<storage, read> deepGiProbeRecords"));
        assert!(PROBE_CLIPMAP_SAMPLING_WGSL.contains("var<storage, read> deepGiLevels"));
    }
}
