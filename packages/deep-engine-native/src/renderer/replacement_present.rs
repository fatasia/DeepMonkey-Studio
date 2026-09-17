use super::Renderer;
use crate::events::RenderOutcome;

impl Renderer {
    pub(crate) fn matches_surface_extent(&self, size: winit::dpi::PhysicalSize<u32>) -> bool {
        self.size == size
    }

    pub(crate) fn has_surface_extent(&self) -> bool {
        self.size.width != 0 && self.size.height != 0
    }
    /// 同窗只能有一个活动 swapchain；保留旧设备资源，仅释放旧窗口呈现资源。
    pub(crate) fn present_replacement(&mut self, candidate: &mut Self) -> RenderOutcome {
        if !self.has_surface_extent() || !candidate.has_surface_extent() {
            return RenderOutcome::Skipped;
        }
        if !std::sync::Arc::ptr_eq(&self.window, &candidate.window) {
            return RenderOutcome::Failed("replacement must use the active window".into());
        }
        // 预建两个未配置 surface，避免回退时再执行可能失败的 surface 创建。
        let old_standby = match self.instance.create_surface(self.window.clone()) {
            Ok(surface) => surface,
            Err(error) => return RenderOutcome::Failed(format!("replacement surface: {error}")),
        };
        let next_standby = match candidate.instance.create_surface(candidate.window.clone()) {
            Ok(surface) => surface,
            Err(error) => return RenderOutcome::Failed(format!("replacement surface: {error}")),
        };
        drop(std::mem::replace(&mut self.surface, old_standby));
        candidate.activate_surface();
        let outcome = candidate.render_internal(true, true);
        if !matches!(outcome, RenderOutcome::Presented) {
            drop(std::mem::replace(&mut candidate.surface, next_standby));
            self.activate_surface();
        }
        outcome
    }
}
