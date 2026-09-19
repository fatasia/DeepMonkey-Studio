use super::*;
use crate::events::RenderOutcome;

pub(super) fn apply_full(app: &mut NativeApp, generation: u64, candidate: WatchedPackage) {
    resume(app, generation, candidate, None);
}

pub(super) fn resume(
    app: &mut NativeApp,
    generation: u64,
    candidate: WatchedPackage,
    retained: Option<Box<Renderer>>,
) {
    if app.packet_coalescer.staged(generation) == PublishDecision::Superseded {
        return;
    }
    let Some(active) = app.renderer.as_ref() else {
        app.packet_coalescer.failed(generation);
        return;
    };
    if !active.has_surface_extent() {
        defer(app, generation, candidate, retained);
        return;
    }
    let Some(window) = app.window.as_ref().cloned() else {
        app.packet_coalescer.failed(generation);
        return;
    };
    // 尺寸不变时复用候选设备；尺寸变更必须重建，不能配置另一活动 swapchain。
    let retained = retained.filter(|renderer| renderer.matches_surface_extent(window.inner_size()));
    let view = candidate
        .content
        .view_after_reload(app.content.active(), app.state.view);
    let mut renderer = if let Some(mut renderer) = retained {
        renderer.set_view(view);
        renderer
    } else {
        let renderer_id = app.next_renderer_id;
        app.next_renderer_id = renderer_id
            .checked_add(1)
            .expect("renderer generation exhausted");
        let staged = pollster::block_on(Renderer::new_candidate(
            window,
            app.proxy.clone(),
            renderer_id,
            &candidate.content,
            view,
            app.features.for_content(&candidate.content),
        ));
        match staged {
            Ok(renderer) => Box::new(renderer),
            Err(error) => {
                app.packet_coalescer.failed(generation);
                eprintln!("runtime package candidate rejected, previous frame retained: {error}");
                return;
            }
        }
    };
    let mailbox = app.package_live_transport.as_ref().unwrap().mailbox.clone();
    mailbox.publish_if_latest(generation, || {
        let Some(active) = app.renderer.as_mut() else {
            app.packet_coalescer.failed(generation);
            return;
        };
        let outcome = present(active, &mut renderer);
        match outcome {
            RenderOutcome::Presented => {
                publish(app, generation, candidate, Some(*renderer));
                crate::runtime_package_startup::presented(app.content.active_mut());
            }
            RenderOutcome::Skipped => {
                defer(app, generation, candidate, Some(renderer));
            }
            RenderOutcome::Recover => {
                // 恢复信号可能意味着候选设备失效，不能复用该设备。
                defer(app, generation, candidate, None);
            }
            RenderOutcome::Failed(error) => {
                app.packet_coalescer.failed(generation);
                eprintln!(
                    "runtime package presentation rejected, previous scene retained: {error}"
                );
                app.request_redraw();
            }
        }
    });
}

fn defer(
    app: &mut NativeApp,
    generation: u64,
    candidate: WatchedPackage,
    renderer: Option<Box<Renderer>>,
) {
    app.package_live_transport.as_mut().unwrap().retry = Some((
        std::time::Instant::now() + PRESENT_RETRY_DELAY,
        generation,
        candidate,
        RetryKind::Full(renderer),
    ));
    app.request_redraw();
}

#[cfg(test)]
thread_local! {
    pub(super) static SKIP_PRESENTATIONS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    pub(super) static RECOVER_PRESENTATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn present(active: &mut Renderer, candidate: &mut Renderer) -> RenderOutcome {
    #[cfg(test)]
    if RECOVER_PRESENTATION.with(|recover| recover.replace(false)) {
        return RenderOutcome::Recover;
    }
    #[cfg(test)]
    if SKIP_PRESENTATIONS.with(|remaining| {
        let count = remaining.get();
        remaining.set(count.saturating_sub(1));
        count > 0
    }) {
        return RenderOutcome::Skipped;
    }
    active.present_replacement(candidate)
}
