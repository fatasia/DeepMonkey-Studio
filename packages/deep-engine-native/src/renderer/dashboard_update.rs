//! Dashboard 整页候选只有在真实帧成功呈现后才保留。
use super::{Renderer, StagedDeep2dUpdate};
use crate::events::RenderOutcome;

impl Renderer {
    pub(crate) fn present_deep2d_update(
        &mut self,
        mut staged: StagedDeep2dUpdate,
    ) -> RenderOutcome {
        // R6-2 细分:这条直换提交路径不经过 publish_deep2d_update,按同族
        // 排查在此补记;Noop(无候选)与未提交(恢复旧帧)不产生样本。
        let prepare_ns = staged.prepare_ns;
        let has_candidate = staged.candidate.is_some();
        std::mem::swap(&mut self.deep2d, &mut staged.candidate);
        let outcome = {
            let mut preview = DashboardFrameGuard {
                renderer: self,
                previous: &mut staged,
                committed: false,
            };
            let outcome = preview.renderer.render_internal(true, true);
            preview.committed = matches!(outcome, RenderOutcome::Presented);
            outcome
        };
        if has_candidate
            && matches!(outcome, RenderOutcome::Presented)
            && let Some(telemetry) = self.telemetry.as_mut()
        {
            telemetry.record_deep2d_prepare(prepare_ns);
        }
        outcome
    }
}

struct DashboardFrameGuard<'a> {
    renderer: &'a mut Renderer,
    previous: &'a mut StagedDeep2dUpdate,
    committed: bool,
}

impl Drop for DashboardFrameGuard<'_> {
    fn drop(&mut self) {
        if !self.committed {
            std::mem::swap(&mut self.renderer.deep2d, &mut self.previous.candidate);
        }
    }
}
