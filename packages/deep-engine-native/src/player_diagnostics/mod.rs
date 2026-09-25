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
        let quality_profile = match crate::renderer::quality_profile::requested() {
            Ok(Some(profile)) => {
                CapabilityStatus::enabled_with_reason("unified_quality_profile", profile.as_str())
            }
            _ => CapabilityStatus::degraded(
                "unified_quality_profile",
                "cross_endpoint_quality_profile_missing",
            ),
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
                // Keep the Native boundary explicit. Probe GI and author fog are
                // real consumers; volumetric fog is only configured when the
                // bounded screen-space integration is selected.
                CapabilityStatus::degraded(
                    "clustered_lighting",
                    "native_clustered_lighting_not_wired",
                ),
                CapabilityStatus::degraded("dynamic_gi", "native_ray_query_dynamic_update_missing"),
                if renderer_features.fog.is_volumetric() {
                    CapabilityStatus::enabled_with_reason(
                        "volumetric_fog",
                        "bounded_screen_space_steps",
                    )
                } else {
                    CapabilityStatus::degraded("volumetric_fog", "native_volumetric_fog_not_wired")
                },
                quality_profile,
                CapabilityStatus::degraded(
                    "frame_graph_receipt",
                    "native_frame_graph_receipt_missing",
                ),
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
                cpu_clock: "web_time::Instant",
                gpu_metric_policy: "timestamp_queries_only; unavailable metrics are degraded",
            },
        }
    }

    pub fn with_metrics(&self, metrics: serde_json::Value) -> serde_json::Value {
        let mut report = serde_json::to_value(self).expect("Player diagnostics serialize");
        let has_frame_pass_receipt = metrics.get("frame_pass_receipt").is_some();
        report["metrics"] = metrics;
        // Telemetry already emits a lightweight, ordered pass receipt. Promote the
        // capability only when that runtime evidence is present; this remains
        // distinct from per-pass GPU timestamps and a full dependency graph.
        if has_frame_pass_receipt {
            if let Some(capability) = report["capabilities"].as_array_mut().and_then(|items| {
                items
                    .iter_mut()
                    .find(|item| item["name"] == "frame_graph_receipt")
            }) {
                capability["status"] = serde_json::Value::String("configured".into());
                capability["reason"] =
                    serde_json::Value::String("native_frame_pass_receipt".into());
            }
        }
        report
    }

    /// F2:正式 Renderer 已建立真实场景 TLAS 驻留。状态仍非完成态——像素
    /// 消费(阴影/反射/GI 着色)未接入,因此保持 degraded,只把原因从
    /// probe_only_renderer_raster 升级为 tlas_resident_pixel_pending。
    pub(crate) fn note_rt_tlas_resident(&mut self) {
        self.note_rt("tlas_resident_pixel_pending");
    }

    /// F2 pixel:TLAS 驻留与 opaque/MASK 方向阴影 Ray Query 管线族同时
    /// 就绪,opaque pass 将真实选择 RT fragment 消费像素。仍非全场景光追
    /// 完成态(仅方向阴影、静态 opaque/MASK),按真实覆盖范围命名原因。
    pub(crate) fn note_rt_directional_shadow_pixels(&mut self) {
        self.note_rt("directional_shadow_ray_query");
    }

    /// F2 pixel:Ray Query 管线族在 device error scope 内创建失败,
    /// fail-closed 丢弃并记录精确原因;栅格主通路不受影响。
    pub(crate) fn note_rt_pixel_rejected(&mut self) {
        self.note_rt("rt_pixel_pipeline_rejected");
    }

    /// Native probe records can be refreshed from authored direct lighting,
    /// but ray-query capture and multi-bounce transport are still absent.
    pub(crate) fn note_native_gi_direct_seed(&mut self) {
        if let Some(capability) = self
            .capabilities
            .iter_mut()
            .find(|item| item.name == "dynamic_gi")
        {
            capability.status = "degraded";
            capability.reason = Some("native_direct_light_seed_only");
        }
    }

    /// CPU cluster planning is bounded and deterministic.
    pub(crate) fn note_native_cluster_plan(&mut self) {
        if let Some(capability) = self
            .capabilities
            .iter_mut()
            .find(|item| item.name == "clustered_lighting")
        {
            capability.status = "degraded";
            capability.reason = Some("native_cluster_plan_cpu_only");
        }
    }

    /// The storage buffer and tile lookup are wired, but cross-GPU visual and
    /// performance evidence is still required before promoting this capability.
    pub(crate) fn note_native_cluster_lookup(&mut self) {
        if let Some(capability) = self
            .capabilities
            .iter_mut()
            .find(|item| item.name == "clustered_lighting")
        {
            capability.status = "degraded";
            capability.reason = Some("native_cluster_lookup_no_visual_evidence");
        }
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

    fn enabled_with_reason(name: &'static str, reason: &'static str) -> Self {
        Self {
            name,
            status: "enabled",
            reason: Some(reason),
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
        // hardware_ray_query stays degraded by design: the device may execute the query
        // probe, but the production renderer exposes no RT pixels yet (F2 residency only).
        assert_eq!(report["capabilities"][1]["name"], "hardware_ray_query");
        assert_eq!(report["capabilities"][1]["status"], "degraded");
        // Configured capabilities report their own run-configuration state; assert by name
        // instead of list position so reordering the capability list cannot silently pass.
        let capability = |name: &str| {
            report["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["name"] == name)
                .unwrap_or_else(|| panic!("capability {name} missing from the report"))
                .clone()
        };
        // Bloom defaults to active; the probe features stay off in this run configuration.
        assert_eq!(capability("bloom")["status"], "enabled");
        assert_eq!(capability("exponential_fog")["status"], "disabled");
        assert_eq!(
            capability("exponential_fog")["reason"],
            "disabled_by_run_configuration"
        );
        assert_eq!(capability("exponential_fog")["status"], "disabled");
        assert_eq!(
            capability("shadow_differential_probe")["status"],
            "disabled"
        );
        assert_eq!(capability("ibl_differential_probe")["status"], "disabled");
        assert_eq!(
            capability("clustered_lighting"),
            serde_json::json!({
                "name": "clustered_lighting",
                "status": "degraded",
                "reason": "native_clustered_lighting_not_wired"
            })
        );
        assert_eq!(
            capability("dynamic_gi")["reason"],
            "native_ray_query_dynamic_update_missing"
        );
        assert_eq!(
            capability("volumetric_fog")["reason"],
            "native_volumetric_fog_not_wired"
        );
        assert_eq!(
            capability("unified_quality_profile")["reason"],
            "cross_endpoint_quality_profile_missing"
        );
        assert_eq!(
            capability("frame_graph_receipt")["reason"],
            "native_frame_graph_receipt_missing"
        );
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

    #[test]
    fn report_promotes_frame_graph_receipt_only_with_runtime_pass_evidence() {
        let diagnostics = PlayerDiagnostics::new(
            wgpu::AdapterInfo::new(wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Dx12),
            wgpu::Features::empty(),
            wgpu::Features::empty(),
            features(true),
            &content(),
        );
        let report = diagnostics.with_metrics(serde_json::json!({
            "frame_pass_receipt": { "schema": "deep-engine.native-frame-pass-receipt", "stages": [] }
        }));
        let capability = report["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "frame_graph_receipt")
            .unwrap();
        assert_eq!(capability["status"], "configured");
        assert_eq!(capability["reason"], "native_frame_pass_receipt");
    }

    #[test]
    fn report_marks_bounded_volumetric_fog_only_when_selected() {
        let mut selected = features(true);
        selected.fog = FogSettings::volumetric(0.08, [0.2, 0.3, 0.4]).unwrap();
        let diagnostics = PlayerDiagnostics::new(
            wgpu::AdapterInfo::new(wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Dx12),
            wgpu::Features::empty(),
            wgpu::Features::empty(),
            selected,
            &content(),
        );
        let capability = diagnostics.with_metrics(serde_json::json!({}))["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "volumetric_fog")
            .unwrap()
            .clone();
        assert_eq!(capability["status"], "enabled");
        assert_eq!(capability["reason"], "bounded_screen_space_steps");
    }

    #[test]
    fn report_distinguishes_direct_gi_seed_from_missing_dynamic_update() {
        let mut diagnostics = PlayerDiagnostics::new(
            wgpu::AdapterInfo::new(wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Dx12),
            wgpu::Features::empty(),
            wgpu::Features::empty(),
            features(true),
            &content(),
        );
        diagnostics.note_native_gi_direct_seed();
        let capability = diagnostics.with_metrics(serde_json::json!({}))["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "dynamic_gi")
            .unwrap()
            .clone();
        assert_eq!(capability["status"], "degraded");
        assert_eq!(capability["reason"], "native_direct_light_seed_only");
    }

    #[test]
    fn report_distinguishes_cpu_cluster_plan_from_gpu_consumer() {
        let mut diagnostics = PlayerDiagnostics::new(
            wgpu::AdapterInfo::new(wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Dx12),
            wgpu::Features::empty(),
            wgpu::Features::empty(),
            features(true),
            &content(),
        );
        diagnostics.note_native_cluster_plan();
        let capability = diagnostics.with_metrics(serde_json::json!({}))["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "clustered_lighting")
            .unwrap()
            .clone();
        assert_eq!(capability["status"], "degraded");
        assert_eq!(capability["reason"], "native_cluster_plan_cpu_only");
    }

    #[test]
    fn report_keeps_cluster_lookup_degraded_until_visual_evidence_exists() {
        let mut diagnostics = PlayerDiagnostics::new(
            wgpu::AdapterInfo::new(wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Dx12),
            wgpu::Features::empty(),
            wgpu::Features::empty(),
            features(true),
            &content(),
        );
        diagnostics.note_native_cluster_lookup();
        let capability = diagnostics.with_metrics(serde_json::json!({}))["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "clustered_lighting")
            .unwrap()
            .clone();
        assert_eq!(
            capability["reason"],
            "native_cluster_lookup_no_visual_evidence"
        );
    }
}
