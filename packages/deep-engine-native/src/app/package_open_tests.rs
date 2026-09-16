use std::{path::PathBuf, sync::mpsc, time::Duration};

use super::PackageOpen;
use crate::player_content::PlayerContent;
use deep_engine_native::runtime_package::load_and_validate_runtime_package;

const WAIT: Duration = Duration::from_secs(3);

#[test]
fn background_loader_reads_a_real_validated_package() {
    let (done, observed) = mpsc::channel();
    let mut open = PackageOpen::with_loader(
        |path| {
            load_and_validate_runtime_package(path)
                .map_err(|error| error.to_string())
                .and_then(PlayerContent::from_package)
        },
        move || done.send(()).is_ok(),
    )
    .unwrap();
    open.request(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime-package-v1.json"),
    )
    .unwrap();
    observed.recv_timeout(WAIT).unwrap();
    let content = open.take_current().unwrap().unwrap();
    assert_eq!(
        content.runtime_package().unwrap().package_id,
        "deep.runtime.golden"
    );
    assert!(!content.packet().instances.is_empty());
}

#[test]
fn blocked_read_coalesces_burst_and_discards_stale_failure() {
    let (started, starts) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let (done, observed) = mpsc::channel();
    let mut open = PackageOpen::with_loader(
        move |path| {
            started.send(path.clone()).unwrap();
            blocked.recv_timeout(WAIT).unwrap();
            Err(path.to_string_lossy().into_owned())
        },
        move || done.send(()).is_ok(),
    )
    .unwrap();
    open.request("first".into()).unwrap();
    assert_eq!(starts.recv_timeout(WAIT).unwrap(), PathBuf::from("first"));
    for index in 0..100 {
        open.request(format!("pending-{index}").into()).unwrap();
    }
    release.send(()).unwrap();
    observed.recv_timeout(WAIT).unwrap();
    assert!(
        open.take_current().is_none(),
        "old error must not replace latest loading state"
    );
    assert_eq!(
        starts.recv_timeout(WAIT).unwrap(),
        PathBuf::from("pending-99")
    );
    release.send(()).unwrap();
    observed.recv_timeout(WAIT).unwrap();
    assert_eq!(open.take_current().unwrap().err().unwrap(), "pending-99");
    assert!(
        starts.try_recv().is_err(),
        "intermediate requests never load"
    );
}

#[test]
fn invalid_file_can_be_retried_without_restarting_worker() {
    let (done, observed) = mpsc::channel();
    let mut open = PackageOpen::with_loader(
        |path| {
            load_and_validate_runtime_package(path)
                .map_err(|error| error.to_string())
                .and_then(PlayerContent::from_package)
        },
        move || done.send(()).is_ok(),
    )
    .unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    open.request(root.join("tests/fixtures")).unwrap();
    observed.recv_timeout(WAIT).unwrap();
    assert!(
        open.take_current()
            .unwrap()
            .err()
            .unwrap()
            .contains("non-regular-file")
    );
    open.request(root.join("tests/fixtures/runtime-package-v1.json"))
        .unwrap();
    observed.recv_timeout(WAIT).unwrap();
    assert!(open.take_current().unwrap().is_ok());
    assert_eq!(open.generation, 2);
}

#[test]
fn exhausted_generation_does_not_enqueue_or_wrap() {
    let (wake, receiver) = mpsc::sync_channel(1);
    let mut open = PackageOpen {
        requests: Default::default(),
        results: Default::default(),
        wake,
        generation: u64::MAX,
        stopped: Default::default(),
    };
    assert!(
        open.request("unused".into())
            .unwrap_err()
            .contains("generation-exhausted")
    );
    assert!(open.requests.take_latest().is_none());
    assert!(receiver.try_recv().is_err());
}

#[test]
fn closing_transport_discards_inflight_result_and_pending_read() {
    struct OnExit(mpsc::Sender<()>);
    impl Drop for OnExit {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    let (exit, exited) = mpsc::channel();
    let exit = OnExit(exit);
    let (started, starts) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let (done, observed) = mpsc::channel();
    let mut open = PackageOpen::with_loader(
        move |path| {
            let _keep_exit_guard = &exit;
            started.send(path).unwrap();
            blocked.recv_timeout(WAIT).unwrap();
            Err("closed read".into())
        },
        move || done.send(()).is_ok(),
    )
    .unwrap();
    open.request("inflight".into()).unwrap();
    starts.recv_timeout(WAIT).unwrap();
    open.request("pending".into()).unwrap();
    drop(open);
    release.send(()).unwrap();
    exited.recv_timeout(WAIT).unwrap();
    assert!(
        starts.try_recv().is_err(),
        "closed transport must not begin queued IO"
    );
    assert!(
        observed.try_recv().is_err(),
        "closed transport must not wake the window"
    );
}
