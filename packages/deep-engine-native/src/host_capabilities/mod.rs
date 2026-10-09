//! Host capability contracts: P4 ray-tracing probe/degradation matrix.
//! Capabilities are adapter-driven data, never compile-time guesses, and
//! every unsupported verdict carries a recorded reason.

pub mod rt_probe;

pub use rt_probe::{
    RAY_QUERY_FEATURE, RT_ACCELERATION_STRUCTURE_BUDGET_MIB, RT_CAPABILITY_CONTRACT_VERSION,
    RtAdapterCapability, RtCapabilityMatrix, RtFallback, RtSupport, RtUnsupportedReason, RtVendor,
    decide_feature_flag, default_matrix, measured_matrix, probe_adapter,
};
