use super::*;
use crate::events::RenderOutcome;

pub(super) fn apply_full(app: &mut NativeApp, generation: u64, candidate: WatchedPackage) {
    if app.packet_coalescer.staged(generation) == PublishDecision::Superseded {
        return;
    }
    let Some(active) = app.renderer.as_ref() else {
        app.packet_coalescer.failed(generation);
        return;
    };
    if !active.has_surface_extent() {
        defer(app, generation, candidate);
        return;
    }
    let Some(window) = app.window.as_ref().cloned() else {
        app.packet_coalescer.failed(generation);
        return;
    };
    let renderer_id = app.next_renderer_id;
    app.next_renderer_id = renderer_id
        .checked_add(1)
        .expect("renderer generation exhausted");
    let staged = pollster::block_on(Renderer::new_candidate(
        window,
        app.proxy.clone(),
        renderer_id,
        &candidate.content,
        candidate
            .content
            .view_after_reload(app.content.active(), app.state.view),
        app.features,
    ));
    let mut renderer = match staged {
        Ok(renderer) => renderer,
        Err(error) => {
            app.packet_coalescer.failed(generation);
            eprintln!("runtime package candidate rejected, previous frame retained: {error}");
            return;
        }
    };
    let mailbox = app.package_live_transport.as_ref().unwrap().mailbox.clone();
    mailbox.publish_if_latest(generation, || {
        let Some(active) = app.renderer.as_mut() else {
            app.packet_coalescer.failed(generation);
            return;
        };
        match active.present_replacement(&mut renderer) {
            RenderOutcome::Presented => {
                publish(app, generation, candidate, Some(renderer));
                crate::runtime_package_startup::presented(app.content.active_mut());
            }
            RenderOutcome::Skipped | RenderOutcome::Recover => {
                defer(app, generation, candidate);
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

fn defer(app: &mut NativeApp, generation: u64, candidate: WatchedPackage) {
    app.package_live_transport.as_mut().unwrap().retry = Some((
        std::time::Instant::now() + PRESENT_RETRY_DELAY,
        generation,
        candidate,
        RetryKind::Full,
    ));
    app.request_redraw();
}
