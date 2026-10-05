//! P4-A: ray-tracing capability probe and degradation contract.
//!
//! 事实修正(2026-10-06,F2 登记修正批):wgpu 30 **确实暴露**实验性
//! acceleration-structure/ray-query API(`wgpu::Features::EXPERIMENTAL_RAY_QUERY`,
//! DX12/Vulkan 后端;创建设备需 `ExperimentalFeatures::enabled()` 显式确认,
//! 见 gpu_context.rs)。因此本探针不再笼统判 `BackendLacksRtApi`,而是按
//! **所选适配器的 feature surface** 分类:
//! - 含该特性位 → Supported(渲染器侧请求该特性并构建 ray-query 管线族,
//!   失败 error-scope fail-closed 回退栅格);
//! - 不含 → Unsupported(HardwareLacksRtUnits:API 存在,该适配器/驱动无 RT 单元)。
//! The contract is adapter-driven and data-driven on purpose — 分类只在本模块
//! 一处决策,渲染器不自行猜测。

use serde::{Deserialize, Serialize};

/// wgpu 30 起暴露的实验性 ray-query 特性位(与 gpu_context.rs 请求位同一常量)。
pub const RAY_QUERY_FEATURE: wgpu::Features = wgpu::Features::EXPERIMENTAL_RAY_QUERY;

/// Supported 适配器的加速结构预算默认值(MiB)。诊断矩阵用保守缺省;
/// 真实上限由 gpu_context 收敛到适配器 actual limits,不在此虚构精确值。
pub const RT_ACCELERATION_STRUCTURE_BUDGET_MIB: u32 = 256;

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

/// The probe verdict for ONE live adapter, derived from the wgpu adapter
/// feature surface (`Adapter::features()`). The classification decision
/// lives in this function alone, so a wgpu upgrade or backend change only
/// flips it here — the renderer keeps reading the same contract.
pub fn probe_adapter(
    vendor: RtVendor,
    adapter_name: &str,
    driver_info: &str,
    backend: &str,
    adapter_features: wgpu::Features,
) -> RtAdapterCapability {
    let ray_query = adapter_features.contains(RAY_QUERY_FEATURE);
    RtAdapterCapability {
        vendor,
        adapter_name: adapter_name.to_string(),
        driver_info: driver_info.to_string(),
        backend: backend.to_string(),
        support: if ray_query {
            RtSupport::Supported
        } else {
            RtSupport::Unsupported
        },
        // wgpu 30 暴露该特性位,适配器缺失即"无 RT 单元"而非"无 API"。
        unsupported_reason: if ray_query {
            None
        } else {
            Some(RtUnsupportedReason::HardwareLacksRtUnits)
        },
        acceleration_structure_budget_mib: if ray_query {
            RT_ACCELERATION_STRUCTURE_BUDGET_MIB
        } else {
            0
        },
    }
}

/// Decides the effective flag: RT runs only when the user's setting is on
/// AND the matrix contains a Supported row. `feature_flag_default` is the
/// factory default (always false) and gates nothing here — a user who
/// explicitly enabled RT on a capable adapter must get RT. Supported 硬件但
/// 用户关闭 → (false, None);无任何 Supported 行时返回矩阵里第一条记录式
/// 理由;NotMeasured 行不虚构理由,如实返回 None(渲染器侧 fail-closed 回退
/// 栅格不受影响)。
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
/// 出厂态是"未实测"(NotMeasured,无理由),不是猜测性的 Unsupported——
/// 真实分类发生在 [`probe_adapter`] 读到适配器 feature surface 之后。
pub fn default_matrix() -> RtCapabilityMatrix {
    let unprobed = |vendor| RtAdapterCapability {
        vendor,
        adapter_name: "unprobed".to_string(),
        driver_info: "unprobed".to_string(),
        backend: "vulkan".to_string(),
        support: RtSupport::NotMeasured,
        unsupported_reason: None,
        acceleration_structure_budget_mib: 0,
    };
    RtCapabilityMatrix {
        contract_version: RT_CAPABILITY_CONTRACT_VERSION,
        adapters: vec![
            unprobed(RtVendor::Nvidia),
            unprobed(RtVendor::Amd),
            unprobed(RtVendor::Intel),
        ],
        feature_flag_default: false,
        fallback: RtFallback::ExistingRasterPath,
    }
}

/// 实测矩阵:用真实适配器的 feature surface 分类(主机启动路径调用)。
pub fn measured_matrix(
    probes: impl IntoIterator<Item = (RtVendor, String, String, String, wgpu::Features)>,
) -> RtCapabilityMatrix {
    let adapters = probes
        .into_iter()
        .map(|(vendor, name, driver, backend, features)| {
            probe_adapter(vendor, &name, &driver, &backend, features)
        })
        .collect();
    RtCapabilityMatrix {
        contract_version: RT_CAPABILITY_CONTRACT_VERSION,
        adapters,
        feature_flag_default: false,
        fallback: RtFallback::ExistingRasterPath,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_classifies_by_experimental_ray_query_feature_bit() {
        // 有特性位 → Supported + 预算;无 → Unsupported(HardwareLacksRtUnits)。
        let rt_adapter = probe_adapter(
            RtVendor::Nvidia,
            "RTX 4060 Laptop",
            "595.79",
            "vulkan",
            RAY_QUERY_FEATURE,
        );
        assert_eq!(rt_adapter.support, RtSupport::Supported);
        assert_eq!(rt_adapter.unsupported_reason, None);
        assert_eq!(
            rt_adapter.acceleration_structure_budget_mib,
            RT_ACCELERATION_STRUCTURE_BUDGET_MIB
        );

        for vendor in [RtVendor::Nvidia, RtVendor::Amd, RtVendor::Intel] {
            let plain = probe_adapter(vendor, "probe", "probe", "vulkan", wgpu::Features::empty());
            assert_eq!(plain.support, RtSupport::Unsupported);
            assert_eq!(
                plain.unsupported_reason,
                Some(RtUnsupportedReason::HardwareLacksRtUnits)
            );
            assert_eq!(plain.acceleration_structure_budget_mib, 0);
        }
    }

    #[test]
    fn unprobed_matrix_is_not_measured_and_flag_stays_off() {
        let matrix = default_matrix();
        assert!(!matrix.feature_flag_default);
        assert!(matrix
            .adapters
            .iter()
            .all(|adapter| adapter.support == RtSupport::NotMeasured));
        // 未实测不虚构理由:返回 None,渲染器依旧 fail-closed 走栅格。
        let (enabled, reason) = decide_feature_flag(&matrix, true);
        assert!(!enabled, "RT must not enable without a Supported adapter");
        assert_eq!(reason, None);
    }

    #[test]
    fn unsupported_adapter_records_reason_and_opt_in_enables_supported() {
        // Unsupported 行的理由必须被记录式带回。
        let unsupported = measured_matrix([(
            RtVendor::Amd,
            "software vulkan".into(),
            "0.0".into(),
            "vulkan".into(),
            wgpu::Features::empty(),
        )]);
        let (enabled, reason) = decide_feature_flag(&unsupported, true);
        assert!(!enabled);
        assert_eq!(reason, Some(RtUnsupportedReason::HardwareLacksRtUnits));

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
