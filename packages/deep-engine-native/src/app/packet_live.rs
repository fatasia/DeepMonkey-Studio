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
        packet_coalescer::SubmitDecision,
        packet_mailbox::LatestMailbox,
        packet_watch::{self, WatchedPacket},
    },
    events::GpuEvent,
};

pub(super) struct PacketLiveTransport {
    mailbox: LatestMailbox<WatchedPacket>,
    published_key: Arc<AtomicU64>,
}

/// Starts the background watcher for `--packet-live` and returns its render-thread
/// endpoint. Both sides share only a single pending slot and the published key.
pub(super) fn start(
    path: PathBuf,
    live_key: u64,
    proxy: EventLoopProxy<GpuEvent>,
) -> PacketLiveTransport {
    let mailbox = LatestMailbox::default();
    let published_key = Arc::new(AtomicU64::new(live_key));
    packet_watch::spawn(path, mailbox.clone(), Arc::clone(&published_key), proxy);
    PacketLiveTransport {
        mailbox,
        published_key,
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
    let previous_packet = app.content.active().packet();
    let Some(renderer) = app.renderer.as_ref() else {
        app.packet_coalescer.failed(generation);
        eprintln!("packet live update ignored: renderer is not running");
        return;
    };
    let staged = match pollster::block_on(
        renderer.stage_render_packet_update(previous_packet, &candidate.value.content),
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
        let metrics = app
            .renderer
            .as_mut()
            .expect("renderer stayed active while staging")
            .publish_render_packet_update(staged)?;
        app.packet_coalescer.publish_ok(generation);
        app.content.publish(generation, *candidate.value.content);
        published_key.store(candidate.value.key, Ordering::Release);
        Ok::<_, String>(metrics)
    });
    let Some(publication) = publication else {
        return;
    };
    match publication {
        Ok(metrics) => {
            super::selection::clear(app);
            super::annotations::clear(app);
            println!(
                "packet live update applied: generation={} published={} {metrics:?}",
                generation,
                app.packet_coalescer.published()
            );
            app.request_redraw();
        }
        Err(error) => {
            app.packet_coalescer.failed(generation);
            eprintln!("packet live update rejected at commit, keeping last correct frame: {error}");
        }
    }
}
