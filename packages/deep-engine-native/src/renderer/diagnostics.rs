use super::*;

impl Renderer {
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
        Some(self.diagnostics.with_metrics(metrics))
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
