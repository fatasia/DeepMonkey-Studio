//! P1-11 CPU rows of the cache-failure/clip matrix. Every cell name
//! (r{row}_c{col}) points at exactly one invalidation/clip combination: each
//! test drives `prepare_runtime_content_cached` against the uncached
//! reference on the shared mixed-content carrier, so a red run names both
//! the cell and the diverging input. GPU row r3 lives in
//! `deep2d_mixed_content_gpu_matrix.rs`.

use deep_engine_native::deep2d::{
    Deep2dDisplayList, Deep2dPathCache, prepare_runtime_content, prepare_runtime_content_cached,
};

#[path = "support/deep2d_mixed_content_fixture.rs"]
mod fixture;
use fixture::content;
#[path = "support/deep2d_cache_clip_matrix.rs"]
mod clips;
#[path = "support/deep2d_cache_invalidation_matrix.rs"]
mod invalidation;

/// One matrix cell: cached prepare must equal the uncached reference, or the
/// cell name names the divergence.
fn cell(
    label: &str,
    list: &Deep2dDisplayList,
    cache: &mut Deep2dPathCache,
) -> deep_engine_native::deep2d::PreparedDeep2dRuntime {
    let reference = prepare_runtime_content(&content(list))
        .unwrap_or_else(|e| panic!("{label}: reference prepare failed: {e}"));
    let cached = prepare_runtime_content_cached(&content(list), cache)
        .unwrap_or_else(|e| panic!("{label}: cached prepare failed: {e}"));
    assert_eq!(
        cached, reference,
        "{label}: cached output diverged from uncached"
    );
    reference
}
