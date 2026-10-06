//! Cluster LOD 选层 compute kernel 的 WGSL 单源 Rust 半(megaLights_wgsl 先例)。
//!
//! 单源 = assets/shaders/cluster_lod_selection_v1.wgsl(由 TS
//! `emitClusterLodSelectionWgsl()` 产物导出,导出脚本随批 A 流程入库);
//! 本模块 include_str 单源 + `.sha256` 校验和夹具,两半同绿 = 双端逐字节。
//! TS 半 checksum:packages/deep-engine/src/rayTracing/clusterLodSelectionKernel.test.ts。

/// 选层 kernel WGSL 单源(include_str;改 WGSL 必须同步 .sha256 夹具)。
pub const CLUSTER_LOD_SELECTION_WGSL: &str =
    include_str!("../assets/shaders/cluster_lod_selection_v1.wgsl");

#[cfg(test)]
mod tests {
    use super::CLUSTER_LOD_SELECTION_WGSL;

    #[test]
    fn single_source_is_nonempty_and_entry_point_present() {
        assert!(CLUSTER_LOD_SELECTION_WGSL.len() > 1000);
        assert!(CLUSTER_LOD_SELECTION_WGSL.contains("fn select_cluster_lod"));
        assert!(CLUSTER_LOD_SELECTION_WGSL.contains("@group(0) @binding(3) var<uniform> params: Params;"));
    }

    #[test]
    fn constants_are_interpolated_from_single_source() {
        assert!(CLUSTER_LOD_SELECTION_WGSL.contains("const REFINE_SENTINEL: u32 = 4294967295u;"));
        assert!(CLUSTER_LOD_SELECTION_WGSL.contains("const MIN_VIEW_DEPTH: f32 = 0.000001;"));
        assert!(CLUSTER_LOD_SELECTION_WGSL.contains("const DEFAULT_PIXEL_THRESHOLD: f32 = 1.0;"));
    }
}
