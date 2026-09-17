//! Atomic Runtime Package publication for the native live-reload path.

use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
};

use winit::event_loop::EventLoopProxy;

use crate::{
    app::{
        NativeApp,
        package_watch::{self, WatchedPackage},
        packet_coalescer::{PublishDecision, SubmitDecision},
        packet_mailbox::LatestMailbox,
    },
    app_startup::report_renderer_ready,
    events::GpuEvent,
    player_content::RuntimePackageSnapshot,
    renderer::Renderer,
};

const PRESENT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);

enum RetryKind {
    Deep2d,
    Scene,
}

#[cfg(all(test, windows))]
#[path = "package_present_tests.rs"]
mod present_tests;

pub(super) struct PackageLiveTransport {
    _watcher: super::watch_thread::WatchThread,
    mailbox: LatestMailbox<WatchedPackage>,
    published: Arc<RwLock<RuntimePackageSnapshot>>,
    retry: Option<(std::time::Instant, u64, WatchedPackage, RetryKind)>,
}

pub(super) fn start(
    path: PathBuf,
    published: RuntimePackageSnapshot,
    proxy: EventLoopProxy<GpuEvent>,
    decoder: package_watch::Decoder,
) -> PackageLiveTransport {
    let mailbox = LatestMailbox::default();
    let published = Arc::new(RwLock::new(published));
    let watcher = package_watch::spawn(
        path,
        mailbox.clone(),
        Arc::clone(&published),
        proxy,
        decoder,
    );
    PackageLiveTransport {
        _watcher: watcher,
        mailbox,
        published,
        retry: None,
    }
}

/// Applies render/shader-only diffs through the GPU scene transaction. Changes to
/// Deep2D or IBL stage a complete renderer while the active renderer remains drawable.
pub(super) fn apply_latest(app: &mut NativeApp) {
    let Some(mut candidate) = app
        .package_live_transport
        .as_ref()
        .and_then(|transport| transport.mailbox.take_latest())
    else {
        return;
    };
    let generation = candidate.generation;
    if !super::annotations::preserve(app) {
        return;
    }
    if app.packet_coalescer.submit(generation) == SubmitDecision::Discard {
        return;
    }
    app.package_live_transport.as_mut().unwrap().retry = None;
    // 后台求值不持发布锁；候选可能基于旧快照，发布前按当前资源重新计划。
    if let Some(current) = app.content.active().runtime_package() {
        match deep_engine_native::runtime_package::plan_runtime_package_resource_diff(
            &current.resource_index,
            &candidate.value.snapshot.resource_index,
        ) {
            Ok(plan) => candidate.value.plan = plan,
            Err(error) => {
                app.packet_coalescer.failed(generation);
                eprintln!("runtime package live replan rejected: {error}");
                return;
            }
        }
    }
    if app
        .renderer
        .as_ref()
        .is_some_and(|renderer| renderer.requires_content_rebuild(&candidate.value.content))
    {
        apply_full(app, generation, candidate.value);
        return;
    }
    if candidate.value.plan.entries.iter().all(|entry| {
        matches!(
            entry.kind,
            deep_engine_native::runtime_package::RuntimeResourceKind::RenderPacket
                | deep_engine_native::runtime_package::RuntimeResourceKind::ShaderPackage
        )
    }) {
        apply_incremental(app, generation, candidate.value);
        return;
    }
    if candidate.value.plan.entries.iter().all(|entry| {
        matches!(
            entry.kind,
            deep_engine_native::runtime_package::RuntimeResourceKind::Deep2dRuntime
                | deep_engine_native::runtime_package::RuntimeResourceKind::ExperimentalX
        )
    }) {
        apply_deep2d(app, generation, candidate.value);
        return;
    }
    apply_full(app, generation, candidate.value);
}

/// 候选内容的资源代次。换包重建时 `PlayerContent::from_package` 已按
/// (package_id, package_hash) 初始化 `document_revision`,但 `resource_set`
/// 在重建后仍为初始值;这里把两段折进一个代次,使**同一包重复发布得到相同值**
/// (幂等,不制造假失效)、**不同包必然不同值**(整批失效)。
fn content_epoch(candidate: &WatchedPackage) -> u64 {
    let epoch = &candidate.content.epoch;
    epoch
        .document_revision
        .rotate_left(17)
        .wrapping_add(epoch.resource_set)
}

fn apply_deep2d(app: &mut NativeApp, generation: u64, candidate: WatchedPackage) {
    if app.packet_coalescer.staged(generation) == PublishDecision::Superseded {
        return;
    }
    let Some(renderer) = app.renderer.as_ref() else {
        app.packet_coalescer.failed(generation);
        return;
    };
    // 换包即新文档代次:上下文用候选内容自带的 epoch(resource_set),
    // 而不是当前活动内容——否则新包条目会沿用旧代见证被误判命中。
    let context = candidate.content.deep2d.as_ref().and_then(|content| {
        let size = app.window.as_ref()?.inner_size();
        Some(crate::deep2d_gpu::deep2d_frame_context(
            content,
            [size.width, size.height],
            content_epoch(&candidate),
        ))
    });
    let staged = match pollster::block_on(
        renderer.stage_deep2d_update_inner(candidate.content.deep2d.as_ref(), context),
    ) {
        Ok(staged) => staged,
        Err(error) => {
            app.packet_coalescer.failed(generation);
            eprintln!(
                "runtime package Deep2D update rejected, keeping last correct frame: {error}"
            );
            return;
        }
    };
    let mailbox = app
        .package_live_transport
        .as_ref()
        .expect("package live transport exists")
        .mailbox
        .clone();
    let Some(deferred) = mailbox.publish_if_latest(generation, || {
        let outcome = app
            .renderer
            .as_mut()
            .expect("renderer stayed active while staging")
            .present_deep2d_update(staged);
        if matches!(outcome, crate::events::RenderOutcome::Presented) {
            publish(app, generation, candidate, None);
            if let Some(notice) =
                crate::runtime_package_startup::presented(app.content.active_mut())
                && let Some(window) = &app.window
            {
                window.set_title(&format!("Deep Engine Native Viewer — {notice}"));
            }
            #[cfg(windows)]
            super::x_runtime::presented(app);
            None
        } else {
            Some((outcome, candidate))
        }
    }) else {
        return;
    };
    if let Some((outcome, candidate)) = deferred {
        match super::dashboard::presented(app, outcome) {
            Ok(false) => {
                app.package_live_transport.as_mut().unwrap().retry = Some((
                    std::time::Instant::now() + PRESENT_RETRY_DELAY,
                    generation,
                    candidate,
                    RetryKind::Deep2d,
                ))
            }
            Err(error) => {
                app.packet_coalescer.failed(generation);
                eprintln!("Deep2D live presentation rejected, previous content retained: {error}");
            }
            Ok(true) => unreachable!("presented candidates were committed above"),
        }
    }
}

pub(super) fn retry(
    app: &mut NativeApp,
    event_loop: &winit::event_loop::ActiveEventLoop,
    now: std::time::Instant,
) -> bool {
    let Some(transport) = app.package_live_transport.as_mut() else {
        return false;
    };
    if transport
        .retry
        .as_ref()
        .is_some_and(|(wake, _, _, _)| *wake <= now)
    {
        let (_, generation, candidate, kind) = transport.retry.take().unwrap();
        match kind {
            RetryKind::Deep2d => apply_deep2d(app, generation, candidate),
            RetryKind::Scene => apply_incremental(app, generation, candidate),
        }
    }
    if let Some((wake, _, _, _)) = app
        .package_live_transport
        .as_ref()
        .and_then(|transport| transport.retry.as_ref())
    {
        event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(*wake));
        true
    } else {
        false
    }
}

fn apply_incremental(app: &mut NativeApp, generation: u64, candidate: WatchedPackage) {
    if app.packet_coalescer.staged(generation) == PublishDecision::Superseded {
        return;
    }
    let previous_packet = app.content.active().packet();
    let Some(renderer) = app.renderer.as_ref() else {
        app.packet_coalescer.failed(generation);
        return;
    };
    let staged = match pollster::block_on(
        renderer.stage_render_packet_update(previous_packet, &candidate.content),
    ) {
        Ok(staged) => staged,
        Err(error) => {
            app.packet_coalescer.failed(generation);
            eprintln!("runtime package live update rejected, keeping last correct frame: {error}");
            return;
        }
    };
    let mailbox = app
        .package_live_transport
        .as_ref()
        .expect("package live transport exists")
        .mailbox
        .clone();
    let publication = mailbox.publish_if_latest(generation, || {
        let (outcome, _) = app
            .renderer
            .as_mut()
            .expect("renderer stayed active while staging")
            .present_render_packet_update(staged)?;
        if !super::dashboard::presented(app, outcome)? {
            app.package_live_transport.as_mut().unwrap().retry = Some((
                std::time::Instant::now() + PRESENT_RETRY_DELAY,
                generation,
                candidate,
                RetryKind::Scene,
            ));
            return Ok(());
        }
        publish(app, generation, candidate, None);
        crate::runtime_package_startup::presented(app.content.active_mut());
        Ok::<_, String>(())
    });
    match publication {
        None | Some(Ok(())) => {}
        Some(Err(error)) => {
            app.packet_coalescer.failed(generation);
            eprintln!(
                "runtime package live update rejected at commit, keeping last correct frame: {error}"
            );
        }
    }
}

fn apply_full(app: &mut NativeApp, generation: u64, candidate: WatchedPackage) {
    let Some(window) = app.window.as_ref().cloned() else {
        app.packet_coalescer.failed(generation);
        return;
    };
    let renderer_id = app.next_renderer_id;
    app.next_renderer_id = app
        .next_renderer_id
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
    let renderer = match staged {
        Ok(mut renderer) => {
            if let Err(error) = renderer.verify_candidate_frame() {
                app.packet_coalescer.failed(generation);
                eprintln!(
                    "runtime package candidate frame rejected, previous frame retained: {error}"
                );
                return;
            }
            renderer
        }
        Err(error) => {
            app.packet_coalescer.failed(generation);
            eprintln!("runtime package live update rejected, keeping last correct frame: {error}");
            return;
        }
    };
    let mailbox = app
        .package_live_transport
        .as_ref()
        .expect("package live transport exists")
        .mailbox
        .clone();
    mailbox.publish_if_latest(generation, || {
        publish(app, generation, candidate, Some(renderer));
    });
}

fn publish(
    app: &mut NativeApp,
    generation: u64,
    candidate: WatchedPackage,
    renderer: Option<Renderer>,
) {
    let transport = app
        .package_live_transport
        .as_ref()
        .expect("package live transport exists");
    let action_count = candidate.plan.entries.len();
    let reused = candidate.plan.reused;
    let package_version = candidate.snapshot.package_version.clone();
    if let Some(renderer) = renderer {
        drop(app.renderer.take());
        renderer.activate_surface();
        app.state.view = candidate
            .content
            .view_after_reload(app.content.active(), app.state.view);
        report_renderer_ready(&renderer);
        app.renderer = Some(renderer);
    }
    app.content.publish(generation, *candidate.content);
    *transport
        .published
        .write()
        .unwrap_or_else(|error| error.into_inner()) = candidate.snapshot;
    app.packet_coalescer.publish_ok(generation);
    app.state.renderer_ready();
    super::selection::clear(app);
    super::annotations::clear(app);
    println!(
        "runtime package live update applied: generation={generation} version={package_version} actions={action_count} reused={reused}"
    );
    app.request_redraw();
}
