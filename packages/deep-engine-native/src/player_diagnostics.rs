//! Stable, machine-readable evidence for the bounded native Player probe.
//!
//! This is deliberately an observation contract: unsupported GPU timing stays
//! degraded in the nested telemetry payload instead of being replaced by an
//! estimate.

use serde::Serialize;

use crate::{player_content::PlayerContent, renderer::RendererFeatures};
use deep_engine_native::hardware_ray_query::ray_query_device_ready;

mod content_identity;
use content_identity::ContentIdentity;

pub const TELEMETRY_WARMUP_FRAMES: u16 = 2;
pub const TELEMETRY_SAMPLE_FRAMES: u16 = 6;

/// Evidence runs may lengthen the bounded telemetry window without changing the
/// ordinary smoke-test defaults. Values stay capped by the telemetry ring so a
/// caller cannot silently discard the beginning of the requested window.
pub fn telemetry_warmup_frames() -> u16 {
    bounded_frame_count(
        "DEEP_ENGINE_TELEMETRY_WARMUP_FRAMES",
        TELEMETRY_WARMUP_FRAMES,
        1,
    )
}

pub fn telemetry_sample_frames() -> u16 {
    bounded_frame_count(
        "DEEP_ENGINE_TELEMETRY_SAMPLE_FRAMES",
        TELEMETRY_SAMPLE_FRAMES,
        2,
    )
}

pub fn telemetry_surface_size() -> Option<winit::dpi::PhysicalSize<u32>> {
    let value = std::env::var("DEEP_ENGINE_TELEMETRY_VIEWPORT").ok()?;
    let (width, height) = value.split_once('x')?;
    let width = width.parse::<u32>().ok()?;
    let height = height.parse::<u32>().ok()?;
    (width >= 64 && height >= 64 && width <= 8192 && height <= 8192)
        .then(|| winit::dpi::PhysicalSize::new(width, height))
}

fn bounded_frame_count(name: &str, fallback: u16, minimum: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| (minimum..=512).contains(value))
        .unwrap_or(fallback)
}

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
    pub fn verification_device(&self) -> serde_json::Value {
        serde_json::to_value(&self.adapter).expect("adapter identity is serializable")
    }
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
        let ray_query = if !adapter_features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
            CapabilityStatus::degraded("hardware_ray_query", "adapter_feature_unavailable")
        } else if !device_features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
            CapabilityStatus::degraded("hardware_ray_query", "device_feature_not_enabled")
        } else if ray_query_device_ready(adapter_features, device_features) {
            // The adapter/device can execute the experimental query probe, but
            // the production renderer still uses raster shadows and does not
            // expose RT pixels as a finished scene capability.
            CapabilityStatus::degraded("hardware_ray_query", "probe_only_renderer_raster")
        } else {
            CapabilityStatus::degraded("hardware_ray_query", "feature_contract_mismatch")
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
                ray_query,
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
                warmup_frames: telemetry_warmup_frames(),
                sample_frames: telemetry_sample_frames(),
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

    /// F2:正式 Renderer 已建立真实场景 TLAS 驻留。状态仍非完成态——像素
    /// 消费(阴影/反射/GI 着色)未接入,因此保持 degraded,只把原因从
    /// probe_only_renderer_raster 升级为 tlas_resident_pixel_pending。
    pub(crate) fn note_rt_tlas_resident(&mut self) {
        self.note_rt("tlas_resident_pixel_pending");
    }

    /// F2:RT 驻留被拒(预算/空场景/几何校验),fail-closed 记录精确原因;
    /// 能力缺失(MissingFeature)维持既有 adapter/device 原因,不覆盖。
    pub(crate) fn note_rt_tlas_rejected(&mut self, reason: &'static str) {
        self.note_rt(reason);
    }

    fn note_rt(&mut self, reason: &'static str) {
        for capability in &mut self.capabilities {
            if capability.name == "hardware_ray_query" {
                capability.reason = Some(reason);
            }
        }
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
    warmup_frames: u16,
    sample_frames: u16,
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
