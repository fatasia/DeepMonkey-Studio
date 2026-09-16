//! Validated Runtime Package watcher for atomic native live reload.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{Duration, SystemTime},
};

use deep_engine_native::runtime_package::{
    RuntimeResourceDiffPlan, parse_and_validate_runtime_package,
    plan_runtime_package_resource_diff, read_runtime_package_bytes,
};
use winit::event_loop::EventLoopProxy;

use crate::{
    app::packet_mailbox::LatestMailbox,
    events::GpuEvent,
    player_content::{PlayerContent, RuntimePackageSnapshot},
};

const POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PackageIdentity {
    modified: Option<SystemTime>,
    len: u64,
}

pub(super) struct WatchedPackage {
    pub content: Box<PlayerContent>,
    pub snapshot: RuntimePackageSnapshot,
    pub plan: RuntimeResourceDiffPlan,
}

enum PackageUpdate {
    Unchanged,
    Equivalent {
        identity: PackageIdentity,
    },
    Rejected {
        reason: String,
        identity: Option<PackageIdentity>,
    },
    Ready {
        package: WatchedPackage,
        identity: PackageIdentity,
    },
}

fn file_identity(path: &Path) -> Result<PackageIdentity, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("cannot stat watched runtime package: {error}"))?;
    Ok(PackageIdentity {
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

fn decode_candidate(
    bytes: &[u8],
    published: &RuntimePackageSnapshot,
) -> Result<Option<WatchedPackage>, String> {
    let package = parse_and_validate_runtime_package(bytes).map_err(|error| error.to_string())?;
    if package.package_id != published.package_id {
        return Err(format!(
            "runtime package id changed from {:?} to {:?}",
            published.package_id, package.package_id
        ));
    }
    if package.package_hash == published.package_hash {
        return Ok(None);
    }
    let plan =
        plan_runtime_package_resource_diff(&published.resource_index, &package.resource_index)
            .map_err(|error| error.to_string())?;
    let snapshot = RuntimePackageSnapshot::from_loaded(&package);
    let content = PlayerContent::from_package(package)?;
    Ok(Some(WatchedPackage {
        content: Box::new(content),
        snapshot,
        plan,
    }))
}

fn load_update(
    path: &Path,
    observed: &PackageIdentity,
    published: &RuntimePackageSnapshot,
) -> PackageUpdate {
    let identity = match file_identity(path) {
        Ok(value) => value,
        Err(reason) => {
            return PackageUpdate::Rejected {
                reason,
                identity: None,
            };
        }
    };
    if identity == *observed {
        return PackageUpdate::Unchanged;
    }
    let rejected = |reason| PackageUpdate::Rejected {
        reason,
        identity: Some(identity),
    };
    let bytes = match read_runtime_package_bytes(path) {
        Ok(value) => value,
        Err(error) => return rejected(format!("cannot read watched runtime package: {error}")),
    };
    match decode_candidate(&bytes, published) {
        Ok(Some(mut package)) => match package.content.bind_resource_source(path, "runtime-file") {
            Ok(()) => PackageUpdate::Ready { package, identity },
            Err(error) => rejected(error),
        },
        Ok(None) => PackageUpdate::Equivalent { identity },
        Err(reason) => rejected(reason),
    }
}

pub(super) fn spawn(
    path: PathBuf,
    mailbox: LatestMailbox<WatchedPackage>,
    published: Arc<RwLock<RuntimePackageSnapshot>>,
    proxy: EventLoopProxy<GpuEvent>,
) {
    std::thread::spawn(move || {
        let mut observed = match file_identity(&path) {
            Ok(value) => value,
            Err(reason) => {
                eprintln!("runtime package watcher disabled: {reason}");
                return;
            }
        };
        let mut generation = 0_u64;
        let mut rejected_identity: Option<Option<PackageIdentity>> = None;
        loop {
            std::thread::sleep(POLL_INTERVAL);
            let update = {
                let published = published.read().unwrap_or_else(|error| error.into_inner());
                load_update(&path, &observed, &published)
            };
            match update {
                PackageUpdate::Unchanged => {}
                PackageUpdate::Equivalent { identity } => {
                    observed = identity;
                    rejected_identity = None;
                }
                PackageUpdate::Rejected { reason, identity } => {
                    if rejected_identity != Some(identity) {
                        eprintln!("runtime package live update rejected: {reason}");
                        rejected_identity = Some(identity);
                    }
                    if let Some(identity) = identity {
                        observed = identity;
                    }
                }
                PackageUpdate::Ready { package, identity } => {
                    generation = generation
                        .checked_add(1)
                        .expect("runtime package watcher generation exhausted");
                    observed = identity;
                    rejected_identity = None;
                    if mailbox.push(generation, package)
                        && proxy.send_event(GpuEvent::PackageArrived).is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
#[path = "package_watch_tests.rs"]
mod tests;
