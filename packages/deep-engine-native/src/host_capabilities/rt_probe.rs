//! P4-A: ray-tracing capability probe and degradation contract. wgpu 30
//! does NOT expose ray-tracing (no acceleration-structure feature, no RT
//! pipeline), so the honest default is: RT unsupported on every adapter,
//! feature flag defaults off, and the renderer stays on the existing
//! raster path with a recorded reason. The contract is adapter-driven and
//! data-driven on purpose — when a backend gains RT, this probe upgrades
//! without touching the renderer.

use serde::{Deserialize, Serialize};

pub const RT_CAPABILITY_CONTRACT_VERSION: u32 = 1;

/// Vendors covered by the capability matrix (P4 acceptance requirement:
/// NVIDIA + at least one non-NVIDIA, or an explicit "not measured" entry).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RtVendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

/// Why RT is unavailable for a given adapter/runtime pair. The reason is
/// recorded — never silently swallowed — so diagnostics can show users why
/// lighting semantics did not change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RtUnsupportedReason {
    /// wgpu exposes no RT feature on this backend version.
    BackendLacksRtApi,
    /// Driver too old for the (future) RT API surface.
    DriverTooOld,
    /// The adapter reports no hardware RT units (e.g. software tier only).
    HardwareLacksRtUnits,
    /// The frame/memory budget for acceleration structures is not met.
    BudgetInsufficient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RtSupport {
    Supported,
    Unsupported,
    NotMeasured,
}

/// Per-adapter capability row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtAdapterCapability {
    pub vendor: RtVendor,
    pub adapter_name: String,
    pub driver_info: String,
    pub backend: String,
    pub support: RtSupport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<RtUnsupportedReason>,
    /// Acceleration-structure budget in MiB when supported; else 0.
    pub acceleration_structure_budget_mib: u32,
}

/// The whole matrix + the feature-flag decision derived from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtCapabilityMatrix {
    pub contract_version: u32,
    pub adapters: Vec<RtAdapterCapability>,
    /// Feature flag default: always off until Supported is proven.
    pub feature_flag_default: bool,
    /// Path used when the flag is off or RT is unsupported.
    pub fallback: RtFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RtFallback {
    /// Keep the existing raster path (Deep Lights / Deep GI Lite untouched).
    ExistingRasterPath,
}

/// The probe verdict for ONE live adapter: derived from the wgpu adapter
/// surface. `wgpu::Adapter` exposes no RT feature today, so the honest
/// classification is Unsupported(BackendLacksRtApi) — but the decision
/// lives in this function alone, so a future wgpu upgrade flips it here.
pub fn probe_adapter(
    vendor: RtVendor,
    adapter_name: &str,
    driver_info: &str,
    backend: &str,
) -> RtAdapterCapability {
    // wgpu 30 surface area check: no ray-tracing feature flags exist
    // (Features has no acceleration_structure / ray_query bits) — the API
    // simply is not exposed yet. Everything else would be speculation.
    RtAdapterCapability {
        vendor,
        adapter_name: adapter_name.to_string(),
        driver_info: driver_info.to_string(),
        backend: backend.to_string(),
        support: RtSupport::Unsupported,
        unsupported_reason: Some(RtUnsupportedReason::BackendLacksRtApi),
        acceleration_structure_budget_mib: 0,
    }
}

/// Decides the effective flag: RT runs only when the user's setting is on
/// AND the matrix contains a Supported row. `feature_flag_default` is the
/// factory default (always false) and gates nothing here — a user who
/// explicitly enabled RT on a capable adapter must get RT. Absence of
/// evidence is "off with a reason", never a silent fallback.
pub fn decide_feature_flag(
    matrix: &RtCapabilityMatrix,
    user_setting: bool,
) -> (bool, Option<RtUnsupportedReason>) {
    let any_supported = matrix
        .adapters
        .iter()
        .any(|adapter| adapter.support == RtSupport::Supported);
    if user_setting && any_supported {
        return (true, None);
    }
    let reason = if any_supported {
        None // capable hardware, but the user kept it off
    } else {
        matrix
            .adapters
            .iter()
            .find_map(|adapter| adapter.unsupported_reason)
    };
    (false, reason)
}

/// The frozen matrix as shipped: every known vendor recorded honestly.
pub fn default_matrix() -> RtCapabilityMatrix {
    RtCapabilityMatrix {
        contract_version: RT_CAPABILITY_CONTRACT_VERSION,
        adapters: vec![
            probe_adapter(RtVendor::Nvidia, "unprobed", "unprobed", "vulkan"),
            probe_adapter(RtVendor::Amd, "unprobed", "unprobed", "vulkan"),
            probe_adapter(RtVendor::Intel, "unprobed", "unprobed", "vulkan"),
        ],
        feature_flag_default: false,
        fallback: RtFallback::ExistingRasterPath,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wgpu30_probe_reports_unsupported_with_reason_on_every_vendor() {
        for vendor in [RtVendor::Nvidia, RtVendor::Amd, RtVendor::Intel] {
            let capability = probe_adapter(vendor, "probe", "probe", "vulkan");
            assert_eq!(capability.support, RtSupport::Unsupported);
            assert_eq!(
                capability.unsupported_reason,
                Some(RtUnsupportedReason::BackendLacksRtApi)
            );
            assert_eq!(capability.acceleration_structure_budget_mib, 0);
        }
    }

    #[test]
    fn flag_stays_off_and_records_reason_until_rt_is_proven() {
        let matrix = default_matrix();
        assert!(!matrix.feature_flag_default);
        let (enabled, reason) = decide_feature_flag(&matrix, true);
        assert!(!enabled, "RT must not enable without a Supported adapter");
        assert_eq!(reason, Some(RtUnsupportedReason::BackendLacksRtApi));
        // User opt-in alone never flips it.
        let (enabled_no_matrix_support, _) = decide_feature_flag(&matrix, true);
        assert!(!enabled_no_matrix_support);
    }

    #[test]
    fn supported_row_plus_opt_in_enables_and_matrix_roundtrips() {
        let mut matrix = default_matrix();
        matrix.adapters[0] = RtAdapterCapability {
            vendor: RtVendor::Nvidia,
            adapter_name: "RTX 4060 Laptop".into(),
            driver_info: "595.79".into(),
            backend: "vulkan".into(),
            support: RtSupport::Supported,
            unsupported_reason: None,
            acceleration_structure_budget_mib: 256,
        };
        let (enabled, reason) = decide_feature_flag(&matrix, true);
        assert!(enabled);
        assert_eq!(reason, None);
        // Fallback stays declared even when enabled.
        assert_eq!(matrix.fallback, RtFallback::ExistingRasterPath);

        let json = serde_json::to_string(&matrix).expect("serialize");
        let round: RtCapabilityMatrix = serde_json::from_str(&json).expect("roundtrip");
        assert_eq!(round, matrix);
    }
}
