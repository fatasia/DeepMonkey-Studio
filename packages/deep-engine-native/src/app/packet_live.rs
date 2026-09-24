//! Live-packet transport and atomic publication on the render thread.

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use winit::event_loop::EventLoopProxy;

use crate::{
    app::{
        NativeApp,
        packet_coalescer::{PublishDecision, SubmitDecision},
        packet_mailbox::LatestMailbox,
        packet_watch::{self, WatchedPacket},
    },
    events::GpuEvent,
};

pub(super) struct PacketLiveTransport {
    _watcher: super::watch_thread::WatchThread,
    mailbox: LatestMailbox<WatchedPacket>,
    published_key: Arc<AtomicU64>,
    retry: Option<(std::time::Instant, u64, WatchedPacket)>,
}

const PRESENT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);

#[cfg(all(test, windows))]
#[path = "packet_present_tests.rs"]
mod present_tests;

/// Starts the background watcher for `--packet-live` and returns its render-thread
/// endpoint. Both sides share only a single pending slot and the published key.
pub(super) fn start(
    path: PathBuf,
    live_key: u64,
    proxy: EventLoopProxy<GpuEvent>,
) -> PacketLiveTransport {
    let mailbox = LatestMailbox::default();
    let published_key = Arc::new(AtomicU64::new(live_key));
    let watcher = packet_watch::spawn(path, mailbox.clone(), Arc::clone(&published_key), proxy);
    PacketLiveTransport {
        _watcher: watcher,
        mailbox,
        published_key,
        retry: None,
    }
}

/// Applies the newest queued candidate. Failed preparation leaves both the active
/// packet and published content key unchanged, so a same-content rewrite may retry.
pub(super) fn apply_latest(app: &mut NativeApp) {
    let Some(candidate) = app
        .packet_live_transport
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
    app.packet_live_transport.as_mut().unwrap().retry = None;
    apply(app, generation, candidate.value);
}

fn apply(app: &mut NativeApp, generation: u64, candidate: WatchedPacket) {
    if app.packet_coalescer.staged(generation) == PublishDecision::Superseded {
        return;
    }
    let previous_packet = app.content.active().packet();
    let Some(renderer) = app.renderer.as_ref() else {
        app.packet_coalescer.failed(generation);
        eprintln!("packet live update ignored: renderer is not running");
        return;
    };
    let staged = match pollster::block_on(
        renderer.stage_render_packet_update(previous_packet, &candidate.content),
    ) {
        Ok(staged) => staged,
        Err(error) => {
            app.packet_coalescer.failed(generation);
            eprintln!("packet live update rejected, keeping last correct frame: {error}");
            return;
        }
    };
    let transport = app
        .packet_live_transport
        .as_ref()
        .expect("live transport exists");
    let mailbox = transport.mailbox.clone();
    let published_key = Arc::clone(&transport.published_key);
    let publication = mailbox.publish_if_latest(generation, || {
        let (outcome, metrics) = app
            .renderer
            .as_mut()
            .expect("renderer stayed active while staging")
            .present_render_packet_update(staged)?;
        if !super::dashboard::presented(app, outcome)? {
            app.packet_live_transport.as_mut().unwrap().retry = Some((
                std::time::Instant::now() + PRESENT_RETRY_DELAY,
                generation,
                candidate,
            ));
            return Ok(None);
        }
        app.packet_coalescer.publish_ok(generation);
        app.content.publish(generation, *candidate.content);
        published_key.store(candidate.key, Ordering::Release);
        Ok::<_, String>(Some(metrics))
    });
    let Some(publication) = publication else {
        return;
    };
    match publication {
        Ok(Some(metrics)) => {
            super::selection::clear(app);
            super::annotations::clear(app);
            println!(
                "packet live update applied: generation={} published={} {metrics:?}",
                generation,
                app.packet_coalescer.published()
            );
            app.request_redraw();
        }
        Ok(None) => {}
        Err(error) => {
            app.packet_coalescer.failed(generation);
            eprintln!("packet live update rejected at commit, keeping last correct frame: {error}");
        }
    }
}

pub(super) fn retry(
    app: &mut NativeApp,
    event_loop: &winit::event_loop::ActiveEventLoop,
    now: std::time::Instant,
) -> bool {
    let Some(transport) = app.packet_live_transport.as_mut() else {
        return false;
    };
    let Some((deadline, _, _)) = transport.retry.as_ref() else {
        return false;
    };
    if now < *deadline {
        #[cfg(not(target_arch = "wasm32"))]
        let flow = winit::event_loop::ControlFlow::WaitUntil(*deadline);
        #[cfg(target_arch = "wasm32")]
        let flow = crate::wasm_compat::control_flow_until(*deadline);
        event_loop.set_control_flow(flow);
        return true;
    }
    let (_, generation, candidate) = transport.retry.take().unwrap();
    apply(app, generation, candidate);
    if let Some((deadline, _, _)) = app
        .packet_live_transport
        .as_ref()
        .and_then(|t| t.retry.as_ref())
    {
        {
            #[cfg(not(target_arch = "wasm32"))]
            let flow = winit::event_loop::ControlFlow::WaitUntil(*deadline);
            #[cfg(target_arch = "wasm32")]
            let flow = crate::wasm_compat::control_flow_until(*deadline);
            event_loop.set_control_flow(flow);
        }
        return true;
    }
    false
}
