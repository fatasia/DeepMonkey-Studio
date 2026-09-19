use super::Renderer;
use crate::gpu_ibl::GpuIblEnvironment;
use deep_engine_native::ibl::{PreparedIblEnvironment, validate_ibl_environment};
#[cfg(test)]
#[path = "source_domain_probe.rs"]
mod source_domain_probe;

pub(super) struct StagedEnvironment {
    pub background: Option<[f64; 3]>,
    pub ibl: GpuIblEnvironment,
    pub frame_bind_group: wgpu::BindGroup,
}
impl StagedEnvironment {
    pub fn swap(&mut self, renderer: &mut Renderer) {
        std::mem::swap(
            &mut self.background,
            &mut renderer.forward_targets.background,
        );
        std::mem::swap(&mut self.ibl, &mut renderer.ibl);
        std::mem::swap(&mut self.frame_bind_group, &mut renderer.frame_bind_group);
    }
}
impl Renderer {
    pub fn ibl_summary(&self) -> (&str, u32, deep_engine_native::ibl::IblSummary) {
        (&self.ibl.id, self.ibl.revision, self.ibl.summary)
    }

    pub(super) async fn stage_environment(
        &self,
        source: &PreparedIblEnvironment,
        background: Option<[f64; 3]>,
    ) -> Result<Option<StagedEnvironment>, String> {
        let summary = validate_ibl_environment(source)?;
        let bytes =
            (summary.specular_texels + summary.diffuse_texels + summary.brdf_texels) as u64 * 8;
        if bytes > 64 * 1024 * 1024 || bytes + self.ibl.resident_bytes > 128 * 1024 * 1024 {
            return Err("native IBL candidate exceeds resident transition budget".into());
        }
        if GpuIblEnvironment::source_identity(source) == self.ibl.identity
            && background == self.forward_targets.background
        {
            return Ok(None);
        }
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = GpuIblEnvironment::new(&self.device, &self.queue, source).map(|ibl| {
            let frame_bind_group = ibl.create_frame_bind_group(
                &self.device,
                &self.frame_layout,
                &self.frame_buffer,
                &self.shadow_map,
                "candidate IBL frame",
                true,
            );
            StagedEnvironment {
                background,
                ibl,
                frame_bind_group,
            }
        });
        if let Some(error) = [
            internal.pop().await,
            memory.pop().await,
            validation.pop().await,
        ]
        .into_iter()
        .flatten()
        .next()
        {
            return Err(format!("native IBL candidate rejected: {error}"));
        }
        candidate.map(Some)
    }
}
