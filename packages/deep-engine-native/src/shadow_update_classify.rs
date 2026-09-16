//! Shadow-relevance classifier for RenderPacket updates (delivery backlog §7.3 #20).
//!
//! Pure CPU decision module: compares the shadow-relevant subset of two packets and
//! reports whether the shadow scene version must be bumped. Emissive-only updates and
//! non-caster metadata (revisions, unused resources, uv1/tangents, samplers) never
//! invalidate; transform, geometry content, caster selection and MASK alpha inputs do.

use deep_engine_native::contract::RenderPacket;

#[path = "shadow_update_classify/packet_diff.rs"]
mod packet_diff;
#[path = "shadow_update_classify/value_compare.rs"]
mod value_compare;

use packet_diff::{geometries_changed, instances_changed, materials_changed, textures_changed};

/// Which shadow-visible facet of the packet changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShadowInvalidation {
    ContractIdentity,
    InstanceSet,
    GeometryContent,
    MaterialCaster,
    TextureContent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShadowRelevance {
    pub must_invalidate: bool,
    pub invalidation: Option<ShadowInvalidation>,
    pub reason: String,
}

/// Decides whether replacing `old` with `new` must bump the shadow scene version.
pub fn classify_shadow_relevance(old: &RenderPacket, new: &RenderPacket) -> ShadowRelevance {
    if old.schema != new.schema || old.version != new.version {
        return ShadowRelevance::changed(
            ShadowInvalidation::ContractIdentity,
            "contract schema/version changed".into(),
        );
    }
    instances_changed(old, new)
        .or_else(|| materials_changed(old, new))
        .or_else(|| geometries_changed(old, new))
        .or_else(|| textures_changed(old, new))
        .unwrap_or_else(|| ShadowRelevance {
            must_invalidate: false,
            invalidation: None,
            reason: "shadow-relevant subset is unchanged".into(),
        })
}

impl ShadowRelevance {
    pub(super) fn changed(invalidation: ShadowInvalidation, reason: String) -> Self {
        Self {
            must_invalidate: true,
            invalidation: Some(invalidation),
            reason,
        }
    }
}
