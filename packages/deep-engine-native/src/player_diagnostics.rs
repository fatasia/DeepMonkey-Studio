//! Stable, machine-readable evidence for the bounded native Player probe.
//!
//! This is deliberately an observation contract: unsupported GPU timing stays
//! degraded in the nested telemetry payload instead of being replaced by an
//! estimate.

use serde::Serialize;

use crate::{player_content::PlayerContent, renderer::RendererFeatures};

mod content_identity;
use content_identity::ContentIdentity;

pub const TELEMETRY_WARMUP_FRAMES: u8 = 2;
pub const TELEMETRY_SAMPLE_FRAMES: u8 = 6;

#[derive(Debug, Serialize)]
pub struct PlayerDiagnostics {
    schema: &'static str,
    version: u8,
    build: BuildIdentity,
    content: ContentIdentity,
    adapter: AdapterIdentity,
    capabilities: Vec<CapabilityStatus>,
    sampling: SamplingMetadata,
}

impl PlayerDiagnostics {
    pub fn backend(&self) -> &str {
        &self.adapter.backend
    }
    pub fn new(
        info: wgpu::AdapterInfo,
        adapter_features: wgpu::Features,
        device_features: wgpu::Features,
        renderer_features: RendererFeatures,
        content: &PlayerContent,
    ) -> Self {
        let timestamps =
            wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        let timestamp = if !renderer_features.telemetry {
            CapabilityStatus::disabled("gpu_timestamp_queries", "not_requested")
        } else if !adapter_features.contains(timestamps) {
            CapabilityStatus::degraded("gpu_timestamp_queries", "timestamp_query_unsupported")
        } else if !device_features.contains(timestamps) {
            CapabilityStatus::degraded(
                "gpu_timestamp_queries",
                "timestamp_query_not_enabled_on_device",
            )
        } else {
            CapabilityStatus::enabled("gpu_timestamp_queries")
        };
        Self {
            schema: "deep-engine.native-player-report",
            version: 1,
            build: BuildIdentity {
                package_version: env!("CARGO_PKG_VERSION"),
                wgpu_api_version: "30.0.1",
                native_shader_version: deep_engine_native::NATIVE_SHADER_VERSION,
                profile: if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                },
                target_os: std::env::consts::OS,
                target_arch: std::env::consts::ARCH,
                source_revision: option_env!("DEEP_ENGINE_SOURCE_REVISION"),
                source_revision_reason: option_env!("DEEP_ENGINE_SOURCE_REVISION")
                    .is_none()
                    .then_some("not_embedded_at_build_time"),
            },
            content: ContentIdentity::from_content(content),
            adapter: AdapterIdentity {
                name: info.name,
                backend: format!("{:?}", info.backend),
                device_type: format!("{:?}", info.device_type),
                vendor_id: info.vendor,
                device_id: info.device,
                pci_bus_id: info.device_pci_bus_id,
                driver: info.driver,
                driver_info: info.driver_info,
            },
            capabilities: vec![
                timestamp,
                CapabilityStatus::configured(
                    "bloom",
                    renderer_features.bloom.is_active(),
                    "disabled_by_run_configuration",
                ),
                CapabilityStatus::configured(
                    "exponential_fog",
                    renderer_features.fog.density() > 0.0,
                    "disabled_by_run_configuration",
                ),
                CapabilityStatus::configured(
                    "shadow_differential_probe",
                    renderer_features.shadow_probe,
                    "not_requested",
                ),
                CapabilityStatus::configured(
                    "ibl_differential_probe",
                    renderer_features.ibl_probe,
                    "not_requested",
                ),
            ],
            sampling: SamplingMetadata {
                warmup_frames: TELEMETRY_WARMUP_FRAMES,
                sample_frames: TELEMETRY_SAMPLE_FRAMES,
                cpu_clock: "std::time::Instant",
                gpu_metric_policy: "timestamp_queries_only; unavailable metrics are degraded",
            },
        }
    }

    pub fn with_metrics(&self, metrics: serde_json::Value) -> serde_json::Value {
        let mut report = serde_json::to_value(self).expect("Player diagnostics serialize");
        report["metrics"] = metrics;
        report
    }
}

#[derive(Debug, Serialize)]
struct BuildIdentity {
    package_version: &'static str,
    wgpu_api_version: &'static str,
    native_shader_version: u32,
    profile: &'static str,
    target_os: &'static str,
    target_arch: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_revision: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_revision_reason: Option<&'static str>,
}

#[derive(Debug, Serialize)]
struct AdapterIdentity {
    name: String,
    backend: String,
    device_type: String,
    vendor_id: u32,
    device_id: u32,
    pci_bus_id: String,
    driver: String,
    driver_info: String,
}

#[derive(Debug, Serialize)]
struct CapabilityStatus {
    name: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl CapabilityStatus {
    fn enabled(name: &'static str) -> Self {
        Self {
            name,
            status: "enabled",
            reason: None,
        }
    }

    fn disabled(name: &'static str, reason: &'static str) -> Self {
        Self {
            name,
            status: "disabled",
            reason: Some(reason),
        }
    }

    fn degraded(name: &'static str, reason: &'static str) -> Self {
        Self {
            name,
            status: "degraded",
            reason: Some(reason),
        }
    }

    fn configured(name: &'static str, enabled: bool, reason: &'static str) -> Self {
        if enabled {
            Self::enabled(name)
        } else {
            Self::disabled(name, reason)
        }
    }
}

#[derive(Debug, Serialize)]
struct SamplingMetadata {
    warmup_frames: u8,
    sample_frames: u8,
    cpu_clock: &'static str,
    gpu_metric_policy: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use deep_engine_native::{
        bloom::BloomSettings,
        contract::{default_fixture_path, load_and_validate},
        fog::FogSettings,
    };

    fn features(telemetry: bool) -> RendererFeatures {
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry,
        }
    }

    fn content() -> PlayerContent {
        let (packet, _) = load_and_validate(default_fixture_path()).unwrap();
        PlayerContent::from_packet(packet, None)
    }

    #[test]
    fn report_keeps_unsupported_gpu_metrics_explicitly_degraded() {
        let diagnostics = PlayerDiagnostics::new(
            wgpu::AdapterInfo::new(wgpu::DeviceType::DiscreteGpu, wgpu::Backend::Vulkan),
            wgpu::Features::empty(),
            wgpu::Features::empty(),
            features(true),
            &content(),
        );
        let report = diagnostics.with_metrics(serde_json::json!({
            "gpu": {"status": "degraded", "reason": "timestamp_query_unsupported"}
        }));
        assert_eq!(report["schema"], "deep-engine.native-player-report");
        assert_eq!(report["sampling"]["warmup_frames"], 2);
        assert_eq!(report["sampling"]["sample_frames"], 6);
        assert_eq!(report["adapter"]["backend"], "Vulkan");
        assert_eq!(report["content"]["kind"], "render-packet");
        assert_eq!(
            report["content"]["scene_content_key"]
                .as_str()
                .unwrap()
                .len(),
            16
        );
        assert_eq!(
            report["content"]["scene_content_key_algorithm"],
            "native-scene-key-v1"
        );
        assert!(report["content"].get("runtime_package_sha256").is_none());
        assert_eq!(
            report["capabilities"][0],
            serde_json::json!({
                "name": "gpu_timestamp_queries",
                "status": "degraded",
                "reason": "timestamp_query_unsupported"
            })
        );
        assert_eq!(report["metrics"]["gpu"]["status"], "degraded");
        assert!(report["metrics"]["gpu"].get("segments").is_none());
        assert_eq!(report["capabilities"][1]["status"], "enabled");
        assert_eq!(report["capabilities"][2]["status"], "disabled");
        assert_eq!(report["capabilities"][3]["status"], "disabled");
    }

    #[test]
    fn report_marks_requested_timestamp_queries_enabled_only_on_the_device() {
        let timestamps =
            wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        let diagnostics = PlayerDiagnostics::new(
            wgpu::AdapterInfo::new(wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Dx12),
            timestamps,
            timestamps,
            features(true),
            &content(),
        );
        let report = diagnostics.with_metrics(serde_json::json!({}));
        assert_eq!(report["capabilities"][0]["status"], "enabled");
        assert!(report["capabilities"][0].get("reason").is_none());
    }
}
