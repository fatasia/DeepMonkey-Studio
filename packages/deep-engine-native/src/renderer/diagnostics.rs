use super::*;

impl Renderer {
    pub fn enable_verification_draws(&self) {
        if let Some(painter) = &self.deep2d {
            painter.enable_draw_evidence();
        }
    }
    pub fn verification_device(&self) -> serde_json::Value {
        self.diagnostics.verification_device()
    }

    pub fn verification_draws(&self) -> Vec<crate::deep2d_gpu::DrawEvidence> {
        self.deep2d
            .as_ref()
            .map(|painter| painter.draw_evidence())
            .unwrap_or_default()
    }
    pub fn verification_backend(&self) -> &str {
        self.diagnostics.backend()
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    /// Isolated ShaderPackage ids + material fallback count for startup evidence.
    pub fn shader_isolation_summary(&self) -> Option<(&[String], usize)> {
        self.scene
            .shader_materials
            .as_ref()
            .map(|materials| (materials.isolated.as_slice(), materials.fallback_materials))
    }

    /// JSON telemetry report; `None` when telemetry was not enabled. The GPU
    /// readback runs its own submit + wait, so this is report-path only.
    pub fn telemetry_report(&self) -> Option<serde_json::Value> {
        let telemetry = self.telemetry.as_ref()?;
        let mut metrics = telemetry.report(&self.device, &self.queue);
        metrics["shadow_cascades"] = serde_json::json!(self.last_shadow_evidence);
        // T01:跨端质量诊断随同一诊断开关并入报告;与
        // packages/deep-engine/src/webgpu/qualityTelemetry.ts 同 schema。
        if let Some(quality) = self.quality.as_ref() {
            metrics["quality"] = quality.report();
        }
        Some(self.diagnostics.with_metrics(metrics))
    }

    /// T01 质量诊断独立读取口(未来消费方/WASM 镜像入口);诊断关闭或
    /// 尚无落账帧时返回 None。
    pub fn quality_report(&self) -> Option<serde_json::Value> {
        let quality = self.quality.as_ref()?;
        (quality.last_frame()).map(|_| quality.report())
    }

    pub fn reset_telemetry(&mut self) {
        if let Some(telemetry) = self.telemetry.as_mut() {
            telemetry.reset_barrier();
        }
    }

    pub fn deep2d_summary(
        &self,
    ) -> Option<deep_engine_native::deep2d::PreparedDeep2dRuntimeSummary> {
        self.deep2d.as_ref().map(|painter| painter.summary)
    }

    pub fn deep2d_atlas_inventory(&self) -> Option<&[serde_json::Value]> {
        self.deep2d
            .as_ref()
            .map(|painter| painter.atlas_inventory())
    }

    pub fn deep2d_vertex_transfer_stats(&self) -> Option<crate::deep2d_gpu::VertexTransferStats> {
        self.deep2d
            .as_ref()
            .map(|painter| painter.vertex_transfer_stats())
    }

    pub fn deep2d_path_cache_stats(
        &self,
    ) -> Option<deep_engine_native::deep2d::Deep2dPathCacheStats> {
        self.deep2d
            .as_ref()
            .map(|painter| painter.path_cache_stats())
    }

    /// 构造期定格的分配档位摘要(P1-09):纯二维判据与前向目标字节估算。
    pub fn content_profile_summary(&self) -> String {
        self.content_profile.summary()
    }

    pub fn pbr_summary(&self) -> (PreparedPbrSummary, usize) {
        (
            self.scene.pbr_summary(),
            self.scene.resident_texture_count(),
        )
    }

    pub fn alpha_summary(&self) -> deep_engine_native::scene::SceneAlphaSummary {
        self.scene.alpha_summary()
    }

    pub fn shadow_summary(&self) -> CascadedShadowGpuMetrics {
        self.shadow_map.metrics()
    }

    pub fn culling_summary(&self) -> GpuCullingSummary {
        self.culling.summary()
    }
}
