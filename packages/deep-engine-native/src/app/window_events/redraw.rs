use super::*;

pub(super) fn redraw(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    app.step_navigation();
    if app.state.verification.is_some()
        && let Some(renderer) = &app.renderer
    {
        renderer.enable_verification_draws();
    }
    let verify = app.state.verification.is_some()
        || app.smoke_frame
        || app.content.active().pending_lkg.is_some()
        || app.content.active().pending_x_lkg.is_some()
        || app.content.active().pending_asset_lkg.is_some();
    // Dynamic playback consumes the real window clock before the frame renders:
    // newly covered deterministic steps mutate the packet and stage a real
    // GPU update, so every present shows the advanced animation state.
    if let Some(probe) = app.dynamic_playback.as_mut()
        && let Some(renderer) = app.renderer.as_mut()
        && let Err(error) = probe.before_render(renderer, app.content.active_mut(), &mut app.state)
    {
        app.state.failed(error);
        event_loop.exit();
        return;
    }
    if let Some(playback) = app.product_dynamic_playback.as_mut()
        && let Some(renderer) = app.renderer.as_mut()
        && let Err(error) =
            playback.before_render(renderer, app.content.active_mut(), &mut app.state)
    {
        app.state.failed(error);
        event_loop.exit();
        return;
    }
    if let Some(playback) = app.product_physics_playback.as_mut()
        && let Some(renderer) = app.renderer.as_mut()
        && let Err(error) = playback.before_render(renderer, app.content.active_mut())
    {
        app.state.failed(error);
        event_loop.exit();
        return;
    }
    // State-op playback applies contracted clipping/selection steps to the real
    // player state on the same fixed clock discipline before the frame renders.
    if let Some(probe) = app.state_ops.as_mut()
        && let Some(renderer) = app.renderer.as_mut()
        && let Err(error) = probe.before_render(renderer, app.content.active(), &mut app.state)
    {
        app.state.failed(error);
        event_loop.exit();
        return;
    }
    // Runtime-only floating origin. The package/source hash stays untouched;
    // packet, physics, camera and history revisions publish as one redraw transaction.
    let rebase = app
        .content
        .active()
        .dynamic_coordinate_rebase(app.state.view);
    match rebase {
        Err(error) => {
            app.state.failed(error);
            event_loop.exit();
            return;
        }
        Ok(Some(candidate)) => {
            let next_view = candidate.view;
            let coordinate_delta = candidate.delta();
            let previous = app.content.active().packet().clone();
            let mut rollback = Some(
                app.content
                    .active_mut()
                    .begin_dynamic_coordinate_rebase(candidate),
            );
            app.state.rebase_local(coordinate_delta);
            let update = {
                let content = app.content.active();
                pollster::block_on(
                    app.renderer
                        .as_mut()
                        .expect("renderer exists")
                        .replace_render_packet(&previous, content),
                )
            };
            if let Err(error) = update {
                app.content
                    .active_mut()
                    .rollback_dynamic_coordinate_rebase(rollback.take().unwrap());
                app.state.rebase_local(coordinate_delta.map(|value| -value));
                app.state.failed(error);
                event_loop.exit();
                return;
            }
            let revision = app.content.active().coordinate_frame_revision();
            if let Err(error) = app
                .renderer
                .as_mut()
                .expect("renderer exists")
                .publish_coordinate_rebase(next_view, revision)
            {
                let rebased = app.content.active().packet().clone();
                app.content
                    .active_mut()
                    .rollback_dynamic_coordinate_rebase(rollback.take().unwrap());
                app.state.rebase_local(coordinate_delta.map(|value| -value));
                let restore = {
                    let content = app.content.active();
                    pollster::block_on(
                        app.renderer
                            .as_mut()
                            .expect("renderer exists")
                            .replace_render_packet(&rebased, content),
                    )
                };
                app.renderer
                    .as_mut()
                    .expect("renderer exists")
                    .set_view(app.state.view);
                let failure = match restore {
                    Ok(_) => error,
                    Err(restore) => format!("{error}; coordinate rollback failed: {restore}"),
                };
                app.state.failed(failure);
                event_loop.exit();
                return;
            }
            app.state.view = next_view;
        }
        Ok(None) => {}
    }
    // R6-2 细分采样:遥测采样窗内(预热结束后)每帧先对真实渲染器提交一次
    // packet 更新(原始↔变体交替),为 packet_scene_update / packet_resource_upload
    // 采集真实样本;随后的帧在同一窗口内呈现更新后的场景。更新失败视为 smoke
    // 失败,不让窗口带着错误状态继续。
    if let Some(replay) = app.telemetry_prepare_replay.as_mut()
        && app.telemetry_warmup_frames_remaining == 0
        && app.telemetry_sample_frames_remaining > 0
        && let Some(renderer) = app.renderer.as_mut()
    {
        // previous 必须是渲染器当前已应用的包(即 next 的另一侧),
        // 否则会出现 original→original 的伪更新回落全量路径,污染测量。
        let previous = if replay.use_alternate {
            app.content.active().packet().clone()
        } else {
            replay.alternate.packet().clone()
        };
        let next = if replay.use_alternate {
            &replay.alternate
        } else {
            &replay.original
        };
        if let Err(error) = pollster::block_on(renderer.replace_render_packet(&previous, next)) {
            app.state.failed(error);
            event_loop.exit();
            return;
        }
        replay.use_alternate = !replay.use_alternate;
    }
    let outcome = app
        .renderer
        .as_mut()
        .map(|renderer| renderer.render(verify));
    if let Some(RenderOutcome::Failed(error)) = outcome.as_ref() {
        app.state.failure = Some(error.clone());
        eprintln!("native frame failed: {error}");
        #[cfg(not(target_arch = "wasm32"))]
        {
            app.startup_frame_pending = false;
            if app.smoke_frame || app.state.verification.is_some() {
                event_loop.exit();
            } else if let Some(window) = app.window.as_ref() {
                // A hidden first-frame failure must remain diagnosable and
                // recoverable through the existing R rebuild action.
                crate::window_chrome::set_title(
                    window,
                    "Deep Engine Native Viewer — first frame failed (press R to rebuild)",
                );
                window.set_visible(true);
            }
        }
        #[cfg(target_arch = "wasm32")]
        event_loop.exit();
        return;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if app.startup_frame_pending
        && matches!(outcome, Some(RenderOutcome::Presented))
        && let Some(window) = &app.window
    {
        // Publish only a fully presented frame; repeated calls after surface
        // recovery are harmless and never expose an unpainted client area.
        app.startup_frame_pending = false;
        crate::window_chrome::set_title(window, "");
        if let Err(error) = crate::window_chrome::reveal_presented_window(window) {
            // The helper always leaves the window visible. Keep rendering and
            // retain diagnostics instead of turning a compositor optimisation
            // into a fatal startup condition.
            eprintln!("native first-frame compositor staging failed: {error}");
        }
    }
    if matches!(outcome, Some(RenderOutcome::Presented))
        && let Some(notice) = crate::runtime_package_startup::presented(app.content.active_mut())
        && let Some(window) = &app.window
    {
        crate::window_chrome::set_title(window, &format!("Deep Engine Native Viewer — {notice}"));
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
        #[cfg(windows)]
        {
            super::super::x_runtime::presented(app);
            if super::super::x_runtime::smoke_pending(app) {
                return;
            }
        }
        if let Some(frame) = app.occlusion_probe {
            // R4 遮挡链冒烟:第 1 帧金字塔 = 远平面(初始化填充,不误剔);
            // 每帧小幅旋转令 update_views 提升 revision → culling 重编码 →
            // 遮挡 dispatch 消费上一帧真实深度(剔除生效)。幸存计数由
            // frame 尾部「native occlusion hiz:」行逐帧如实打印。
            if frame < 3 {
                app.rotate(0.02);
            }
            app.occlusion_probe = Some(frame + 1);
            if frame + 1 >= 4 {
                println!(
                    "native occlusion hiz smoke OK: frames={} rotation=0.06rad",
                    frame + 1
                );
                event_loop.exit();
            } else {
                app.request_redraw();
            }
            return;
        }
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
    if let Some(probe) = app.dynamic_playback.as_mut() {
        match outcome {
            Some(RenderOutcome::Presented) => {
                match probe.after_present() {
                    AfterPresent::Continue => app.request_redraw(),
                    AfterPresent::Complete(receipt) => {
                        println!("native dynamic playback receipt: {receipt}");
                        event_loop.exit();
                    }
                }
                return;
            }
            Some(RenderOutcome::Skipped) => {
                // A skipped frame must not advance the receipt: retry.
                app.request_redraw();
                return;
            }
            // Recover falls through to the standard surface-recreation path.
            _ => {}
        }
    }
    if let Some(playback) = app.state_ops.as_mut() {
        match outcome {
            Some(RenderOutcome::Presented) => {
                match playback.after_present() {
                    state_ops_playback::AfterPresent::Continue => app.request_redraw(),
                    state_ops_playback::AfterPresent::Complete(receipt) => {
                        println!("native state ops receipt: {receipt}");
                        event_loop.exit();
                    }
                }
                return;
            }
            Some(RenderOutcome::Skipped) => {
                // A skipped frame must not advance the receipt: retry.
                app.request_redraw();
                return;
            }
            // Recover falls through to the standard surface-recreation path.
            _ => {}
        }
    }
    if verify && matches!(outcome, Some(RenderOutcome::Skipped)) {
        app.request_redraw();
    }
    #[cfg(windows)]
    if matches!(outcome, Some(RenderOutcome::Presented)) {
        super::super::x_runtime::presented(app);
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
