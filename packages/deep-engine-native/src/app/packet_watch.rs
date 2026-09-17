//! File-watching transport for dynamic RenderPacket updates.
//!
//! The narrowest public update entry for the native player: `--packet-live <file>`
//! re-validates the watched file on every change and forwards only contract-valid,
//! content-different packets to the render thread. No network protocol, no new
//! dependencies; a file identity check keeps steady-state cost at one `stat` per tick.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime};

use deep_engine_native::contract::{RenderPacket, read_render_packet_bytes};
use winit::event_loop::EventLoopProxy;

use crate::{
    app::packet_mailbox::LatestMailbox, events::GpuEvent, player_content::PlayerContent,
    player_shader_plan::scene_content_key,
};

/// Watch cadence. Long enough to stay invisible, short enough for live edits.
pub(super) const POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) struct PacketIdentity {
    modified: Option<SystemTime>,
    len: u64,
}

pub(super) enum PacketUpdate {
    /// Identity matches the last observed one; no disk read happened.
    Unchanged,
    /// File identity changed, but its validated content is already published.
    Equivalent { identity: PacketIdentity },
    /// File changed but is unreadable, invalid, or content-equal to the live packet.
    /// The last correct frame stays; `reason` is user-facing and safe to log.
    Rejected {
        reason: String,
        identity: Option<PacketIdentity>,
    },
    /// Contract-valid packet with a new content key.
    Ready {
        content: Box<PlayerContent>,
        key: u64,
        identity: PacketIdentity,
    },
}

pub(super) struct WatchedPacket {
    pub content: Box<PlayerContent>,
    pub key: u64,
}

fn file_identity(path: &Path) -> Result<PacketIdentity, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("cannot stat watched packet: {error}"))?;
    Ok(PacketIdentity {
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

/// Loads and validates the watched file, or explains why it must be rejected.
/// `observed` is the identity already accounted for; `live_key` is the content key
/// of the packet the renderer currently shows.
pub(super) fn load_update(
    path: &Path,
    observed: Option<&PacketIdentity>,
    live_key: u64,
) -> PacketUpdate {
    let identity = match file_identity(path) {
        Ok(value) => value,
        Err(reason) => {
            return PacketUpdate::Rejected {
                reason,
                identity: None,
            };
        }
    };
    if observed == Some(&identity) {
        return PacketUpdate::Unchanged;
    }
    let rejected = |reason: String| PacketUpdate::Rejected {
        reason,
        identity: Some(identity),
    };
    let bytes = match read_render_packet_bytes(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            // 临时共享锁或读取失败不能把未读取的内容登记为已观察。
            return PacketUpdate::Rejected {
                reason: format!("cannot read watched packet: {error}"),
                identity: None,
            };
        }
    };
    let packet: RenderPacket = match load_and_validate_bytes(&bytes) {
        Ok(packet) => packet,
        Err(reason) => return rejected(reason),
    };
    let key = scene_content_key(&packet);
    if key == live_key {
        return PacketUpdate::Equivalent { identity };
    }
    PacketUpdate::Ready {
        content: Box::new(PlayerContent::from_packet(packet, None)),
        key,
        identity,
    }
}

/// Byte-level mirror of `load_and_validate` for the already-read watched file.
fn load_and_validate_bytes(bytes: &[u8]) -> Result<RenderPacket, String> {
    if bytes.len() > 160 * 1024 * 1024 {
        return Err("contract file exceeds the 160 MiB input limit".into());
    }
    let packet: RenderPacket = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid RenderPacket JSON: {error}"))?;
    deep_engine_native::contract::validate_packet(&packet)?;
    Ok(packet)
}

/// Watcher lifetime follows its transport; cancelled reads never enqueue a candidate.
pub(super) fn spawn(
    path: PathBuf,
    mailbox: LatestMailbox<WatchedPacket>,
    published_key: Arc<AtomicU64>,
    proxy: EventLoopProxy<GpuEvent>,
) -> super::watch_thread::WatchThread {
    super::watch_thread::WatchThread::spawn(move |stop| {
        let mut observed = None;
        let mut generation = 0_u64;
        let mut last_rejected_identity: Option<Option<PacketIdentity>> = None;
        while stop.wait(POLL_INTERVAL) {
            let update = load_update(
                &path,
                observed.as_ref(),
                published_key.load(Ordering::Acquire),
            );
            if stop.cancelled() {
                return;
            }
            match update {
                PacketUpdate::Unchanged => {}
                PacketUpdate::Equivalent { identity } => {
                    observed = Some(identity);
                    last_rejected_identity = None;
                }
                PacketUpdate::Rejected { reason, identity } => {
                    // Log a given file version once instead of every tick.
                    if last_rejected_identity != Some(identity) {
                        eprintln!("packet live update rejected: {reason}");
                        last_rejected_identity = Some(identity);
                    }
                    observed = identity;
                }
                PacketUpdate::Ready {
                    content,
                    key,
                    identity,
                } => {
                    generation = generation
                        .checked_add(1)
                        .expect("packet watcher generation exhausted");
                    observed = Some(identity);
                    last_rejected_identity = None;
                    let needs_wake = mailbox.push(generation, WatchedPacket { content, key });
                    if needs_wake && proxy.send_event(GpuEvent::PacketArrived).is_err() {
                        return;
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use deep_engine_native::contract::default_fixture_path;

    use super::{POLL_INTERVAL, PacketIdentity, PacketUpdate, load_update};

    fn temp_packet(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "deep-engine-native-packet-watch-{}-{name}",
            std::process::id()
        ));
        fs::write(&path, bytes).expect("write temp packet");
        path
    }

    fn fixture_bytes() -> Vec<u8> {
        fs::read(default_fixture_path()).expect("fixture bytes")
    }

    fn wait_distinct_mtime() {
        std::thread::sleep(POLL_INTERVAL);
    }

    #[test]
    fn watcher_rejects_invalid_and_skips_content_equal_rewrites() {
        let path = temp_packet("decision.json", &fixture_bytes());
        let unseen = PacketIdentity {
            modified: None,
            len: 0,
        };
        let PacketUpdate::Ready { key, identity, .. } = load_update(&path, Some(&unseen), u64::MAX)
        else {
            panic!("first observation must load the initial packet");
        };
        assert_ne!(key, u64::MAX);

        // Identity unchanged -> no disk decode, no update.
        assert!(matches!(
            load_update(&path, Some(&identity), key),
            PacketUpdate::Unchanged
        ));

        // A changed file that fails the contract is rejected with a readable reason.
        wait_distinct_mtime();
        fs::write(&path, b"{\"schema\": \"deep-engine.render-packet\"}").unwrap();
        let PacketUpdate::Rejected { reason, .. } = load_update(&path, Some(&identity), key) else {
            panic!("invalid packet must be rejected");
        };
        assert!(
            reason.contains("RenderPacket") || reason.contains("missing field"),
            "{reason}"
        );

        // The rejected version never becomes the observed identity; a content-equal
        // rewrite stays zero work instead of restaging identical GPU data.
        wait_distinct_mtime();
        fs::write(&path, fixture_bytes()).unwrap();
        assert!(matches!(
            load_update(&path, Some(&identity), key),
            PacketUpdate::Equivalent { .. }
        ));

        // A real content change (moved instance) yields a Ready update with a new key.
        wait_distinct_mtime();
        fs::write(&path, moved_instance_bytes()).unwrap();
        let PacketUpdate::Ready {
            content,
            key: moved,
            ..
        } = load_update(&path, Some(&identity), key)
        else {
            panic!("content-different rewrite must load");
        };
        assert_ne!(moved, key);
        assert_eq!(moved, content.scene_content_key());
        fs::remove_file(&path).ok();
    }

    fn moved_instance_bytes() -> Vec<u8> {
        let mut value: serde_json::Value =
            serde_json::from_slice(&fixture_bytes()).expect("fixture JSON");
        value["instances"][0]["transform"][12] = serde_json::json!(-0.75);
        serde_json::to_vec(&value).expect("serialize mutated packet")
    }
}

#[cfg(test)]
#[path = "packet_watch_limits_tests.rs"]
mod limits_tests;
