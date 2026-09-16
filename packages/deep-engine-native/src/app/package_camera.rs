use super::NativeApp;
use crate::{player_content::PlayerContent, renderer::Renderer};

/// 视角变化先在独立渲染器验证，避免对正在显示的相机执行可能失败的半次更新。
pub(super) fn stage_open_camera(
    app: &mut NativeApp,
    content: &PlayerContent,
) -> Result<Option<Renderer>, String> {
    let view = content.initial_view();
    let allocation_changed = app
        .renderer
        .as_ref()
        .is_some_and(|renderer| renderer.requires_content_rebuild(content));
    if view == app.state.view && !allocation_changed {
        return Ok(None);
    }
    let window = app.window.clone().ok_or("window unavailable")?;
    let id = app.next_renderer_id;
    app.next_renderer_id = id.checked_add(1).ok_or("renderer generation exhausted")?;
    let mut renderer = pollster::block_on(Renderer::new_candidate(
        window,
        app.proxy.clone(),
        id,
        content,
        view,
        app.features,
    ))?;
    renderer.verify_candidate_frame()?;
    Ok(Some(renderer))
}
