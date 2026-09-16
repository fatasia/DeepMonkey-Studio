use super::*;

pub(super) fn redraw(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    if app.state.verification.is_some()
        && let Some(renderer) = &app.renderer
    {
        renderer.enable_verification_draws();
    }
    let verify = app.state.verification.is_some()
        || app.smoke_frame
        || app.content.active().pending_lkg.is_some()
        || app.content.active().pending_asset_lkg.is_some();
    let outcome = app
        .renderer
        .as_mut()
        .map(|renderer| renderer.render(verify));
    if let Some(RenderOutcome::Failed(error)) = outcome.as_ref() {
        app.state.failure = Some(error.clone());
        event_loop.exit();
        return;
    }
    if matches!(outcome, Some(RenderOutcome::Presented))
        && let Some(notice) = crate::runtime_package_startup::presented(app.content.active_mut())
        && let Some(window) = &app.window
    {
        window.set_title(&format!("Deep Engine Native Viewer — {notice}"));
    }
    if matches!(outcome, Some(RenderOutcome::Presented))
        && let Some(verification) = app.state.verification.as_mut()
    {
        let size = app.window.as_ref().expect("window exists").inner_size();
        let renderer = app.renderer.as_ref().expect("renderer exists");
        if let Err(error) = verification.observe_draws(
            renderer.verification_device(),
            renderer.verification_draws(),
        ) {
            app.state.failed(error);
            event_loop.exit();
            return;
        }
        let backend = app
            .renderer
            .as_ref()
            .expect("renderer exists")
            .verification_backend()
            .to_owned();
        match verification.presented(size.width, size.height, backend) {
            Ok(true) => event_loop.exit(),
            Ok(false) => app.request_redraw(),
            Err(error) => {
                app.state.failed(error);
                event_loop.exit();
            }
        }
        return;
    }
    if app.smoke_frame && matches!(outcome, Some(RenderOutcome::Presented)) {
        if app.chart_key_probe.is_some() {
            match super::chart_keyboard_smoke::advance_smoke(app) {
                Ok(false) => {
                    app.request_redraw();
                    return;
                }
                Ok(true) => {}
                Err(error) => {
                    app.state.failed(error);
                    event_loop.exit();
                    return;
                }
            }
        }
        if app.chart_probe.is_some() {
            match super::chart_smoke::advance_smoke(app) {
                Ok(false) => {
                    app.request_redraw();
                    return;
                }
                Ok(true) => {}
                Err(error) => {
                    app.state.failed(error);
                    event_loop.exit();
                    return;
                }
            }
        }
        if app.section_probe.is_some() {
            match super::section_probe::advance(app) {
                Ok(false) => {
                    app.request_redraw();
                    return;
                }
                Ok(true) => {}
                Err(error) => {
                    app.state.failed(error);
                    event_loop.exit();
                    return;
                }
            }
        }
        if app.selection_probe.is_some() {
            match super::selection_probe::advance(app, event_loop) {
                Ok(false) => {
                    app.request_redraw();
                    return;
                }
                Ok(true) => {}
                Err(error) => {
                    app.state.failed(error);
                    event_loop.exit();
                    return;
                }
            }
        }
        match advance_probes(app, event_loop) {
            ProbeProgress::Complete => {}
            ProbeProgress::Redraw => {
                app.request_redraw();
                return;
            }
            ProbeProgress::WaitForEvent => return,
        }
        if app.telemetry_warmup_frames_remaining > 0 {
            app.telemetry_warmup_frames_remaining -= 1;
            if app.telemetry_warmup_frames_remaining == 0 {
                app.renderer
                    .as_mut()
                    .expect("renderer remains ready during telemetry warmup")
                    .reset_telemetry();
            }
            app.request_redraw();
            return;
        }
        if app.telemetry_sample_frames_remaining > 1 {
            app.telemetry_sample_frames_remaining -= 1;
            app.request_redraw();
            return;
        }
        if app.telemetry_sample_frames_remaining == 1
            && let Some(report) = app.renderer.as_ref().and_then(Renderer::telemetry_report)
        {
            app.telemetry_sample_frames_remaining = 0;
            println!("native telemetry report: {report}");
        }
        let size = app.window.as_ref().expect("window exists").inner_size();
        report_presented(size, app.content.active().deep2d.is_some());
        event_loop.exit();
        return;
    }
    if verify && matches!(outcome, Some(RenderOutcome::Skipped)) {
        app.request_redraw();
    }
    if matches!(outcome, Some(RenderOutcome::Recover)) {
        if app.smoke_frame || app.state.verification.is_some() {
            app.state.failure = Some("surface was lost during native verification frame".into());
            event_loop.exit();
            return;
        }
        app.renderer = None;
        app.initialize_renderer();
    }
}

enum ProbeProgress {
    Complete,
    Redraw,
    WaitForEvent,
}

fn advance_probes(app: &mut NativeApp, event_loop: &ActiveEventLoop) -> ProbeProgress {
    if let Some(probe) = app.shadow_update_probe.as_mut() {
        let result = probe.after_present(
            app.renderer.as_mut().expect("renderer exists"),
            app.content.active_mut(),
        );
        match result {
            Ok(false) => {
                return ProbeProgress::Redraw;
            }
            Ok(true) => {}
            Err(error) => {
                app.state.failure = Some(error);
                event_loop.exit();
                return ProbeProgress::WaitForEvent;
            }
        }
    }
    if let Some(probe) = app.packet_live_probe.as_mut() {
        let result = probe.after_present(app.renderer.as_mut().expect("renderer exists"));
        match result {
            Ok(false) => {
                return ProbeProgress::WaitForEvent;
            }
            Ok(true) => {}
            Err(error) => {
                app.state.failure = Some(error);
                event_loop.exit();
                return ProbeProgress::WaitForEvent;
            }
        }
    }
    ProbeProgress::Complete
}
