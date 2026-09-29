//! J2-B7 frame ABI 指纹门与双端 parity 门。
//! 规格：deep-engine/docs/specs/frame-abi-unification-spec-20260929.md §4/§7。
//! schema：packages/deep-engine/frame-abi/frame-abi.schema.json（单一真源）。

use crate::frame_layout_generated::*;
use crate::mesh_abi::{
    FRAME_FOG_PROFILE_ROW, FRAME_FOG_PROJECTION_ROW, FRAME_LOCAL_SOFTNESS_ROW, FRAME_UNIFORM_BYTES,
    FRAME_UNIFORM_FLOATS,
};
use crate::shader_package::hash::sha256;

/// 编译期钉住 schema 原文；指纹门比对产物头戳。
const SCHEMA_BYTES: &str = include_str!("../../deep-engine/frame-abi/frame-abi.schema.json");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_fingerprint_matches_generated_stamp() {
        assert_eq!(sha256(SCHEMA_BYTES.as_bytes()), FRAME_ABI_SCHEMA_SHA256);
    }

    #[test]
    fn rust_host_parity_with_hand_mesh_abi() {
        // 手写常量（mesh_abi.rs）与生成常量并存期的一致锁；migrate 后由生成侧单源接替。
        assert_eq!(FRAME_ABI_RUST_FLOATS, FRAME_UNIFORM_FLOATS);
        assert_eq!(FRAME_ABI_RUST_BYTES, FRAME_UNIFORM_BYTES);
        assert_eq!(FRAME_ABI_FOG_PROJECTION_ROW, FRAME_FOG_PROJECTION_ROW);
        assert_eq!(FRAME_ABI_LOCAL_SOFTNESS_ROW, FRAME_LOCAL_SOFTNESS_ROW);
        assert_eq!(FRAME_ABI_FOG_PROFILE_ROW, FRAME_FOG_PROFILE_ROW);
    }

    #[test]
    fn ts_host_identity_is_frozen() {
        // TS 宿主真值：webgpu/pipelines.ts:14-15（PBR_FRAME_UNIFORM_FLOATS=96）。
        assert_eq!(FRAME_ABI_TS_FLOATS, 96);
        assert_eq!(FRAME_ABI_TS_BYTES, 384);
    }

    #[test]
    fn core_segment_rows_match_schema_declaration() {
        assert_eq!(FRAME_ABI_VIEW_PROJECTION, 0);
        assert_eq!(FRAME_ABI_LIGHT_VIEW_PROJECTION, 4);
        assert_eq!(FRAME_ABI_EYE, 8);
        assert_eq!(FRAME_ABI_LIGHT_DIRECTION, 11);
        assert_eq!(FRAME_ABI_SUN_COLOR, 13);
    }

    #[test]
    fn rust_rows_tile_without_gap_is_locked_by_codegen_side() {
        // 铺满校验在生成器内执行（零缺口零重叠才放行产物）；此处锁总行数防手改。
        assert_eq!(FRAME_ABI_RUST_ROWS, 149);
    }
}
