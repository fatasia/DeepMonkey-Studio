//! Dashboard 整页候选只有在真实帧成功呈现后才保留。
use super::{Renderer, StagedDeep2dUpdate};
use crate::events::RenderOutcome;

impl Renderer {
    pub(crate) fn present_deep2d_update(
        &mut self,
        mut staged: StagedDeep2dUpdate,
    ) -> RenderOutcome {
        std::mem::swap(&mut self.deep2d, &mut staged.candidate);
        let mut preview = DashboardFrameGuard {
            renderer: self,
            previous: &mut staged,
            committed: false,
        };
        let outcome = preview.renderer.render_internal(true, true);
        preview.committed = matches!(outcome, RenderOutcome::Presented);
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
