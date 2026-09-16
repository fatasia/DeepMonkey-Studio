mod command_types;
mod hit_index;
mod painter;
mod painter_cache;
pub use painter_cache::{Deep2dPathCache, Deep2dPathCacheStats};
mod base64_encode;
mod painter_atlas;
mod painter_clip;
mod painter_dash;
mod painter_geometry;
mod painter_math;
mod painter_path;
mod painter_path_intersections;
mod painter_polygon;
mod painter_polygon_bridge;
mod painter_prepare;
mod painter_stroke;
pub mod raster_reference;
#[allow(clippy::duplicate_mod)] // runtime_package/prefiltered_ibl.rs reuses this via #[path]
pub(crate) mod runtime_base64;
pub(crate) use base64_encode::encode as encode_base64;
mod runtime_layers;
mod runtime_prepare;
mod runtime_quad;
mod runtime_types;
mod runtime_validate;
mod runtime_validate_values;
mod stroke_caps;
mod types;
mod validate;
mod validate_commands;
mod validate_commands_kinds;
mod validate_resources;
mod validate_text;

pub use types::*;
pub use validate::{decode_display_list, validate_display_list};

pub const DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION: u32 = 1;

pub fn default_display_list_fixture_path() -> &'static std::path::Path {
    std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/deep2d_path_only_v1.json"
    ))
}

pub fn default_smoke_display_list_fixture_path() -> &'static std::path::Path {
    std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/deep2d_tessellated_v1.json"
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deep2dBudgets {
    pub resources: usize,
    pub commands: usize,
    pub path_verbs_per_resource: usize,
    pub path_verbs_total: usize,
    pub clips_per_command: usize,
    pub dash_entries: usize,
    pub text_code_units_per_command: usize,
    pub text_code_units_total: usize,
}

pub const DEEP_2D_DISPLAY_LIST_BUDGETS: Deep2dBudgets = Deep2dBudgets {
    resources: 65_536,
    commands: 262_144,
    path_verbs_per_resource: 1_000_000,
    path_verbs_total: 2_000_000,
    clips_per_command: 64,
    dash_entries: 64,
    text_code_units_per_command: 1_000_000,
    text_code_units_total: 4_000_000,
};
pub use command_types::*;
pub use hit_index::{Deep2dHitEntry, Deep2dHitIndex, Deep2dHitKind, build_hit_index};
pub use painter::{
    Deep2dPainterError, Deep2dPainterIssue, Deep2dPainterIssueCode, PreparedDeep2d,
    PreparedDeep2dGlyph, PreparedDeep2dPathChunk, PreparedDeep2dSummary, prepare_display_list,
    prepare_display_list_cached,
};
pub use painter_path::{DEEP2D_CURVE_TOLERANCE, DEEP2D_MAX_FLATTENED_SEGMENTS};
pub use raster_reference::{
    LetterboxMapping, PixelComparison, ReferenceTriangle, compare, rasterize,
};
pub use runtime_prepare::{
    PreparedDeep2dAtlas, PreparedDeep2dChunk, PreparedDeep2dChunkKind, PreparedDeep2dRuntime,
    PreparedDeep2dRuntimeSummary, prepare_runtime_content, prepare_runtime_content_cached,
};
pub use runtime_types::*;
pub use runtime_validate::{decode_runtime_content, validate_runtime_package};

mod runtime_composite;
mod runtime_composite_prepare;
mod runtime_namespace;
pub use runtime_composite::{Deep2dComposite, Deep2dLayer};

#[cfg(test)]
mod runtime_composite_tests;

#[cfg(test)]
mod runtime_composite_cache_tests;
