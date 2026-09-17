use deep_engine_native::compat_x::{process::*, *};
use std::{
    process::Command,
    time::{Duration, Instant},
};

fn request() -> XRequest {
    XRequest {
        schema_version: 1,
        expected_epoch: 7,
        started_at_ms: 100,
        random_seed: 42,
        resources: vec![XResource {
            id: "fixture.data".into(),
            bytes: vec![3, 5, 8],
        }],
        events: vec![
            XEvent::Pointer { x: 12.0, y: 24.0 },
            XEvent::Key { code: XKey::Enter },
        ],
        calls: vec![XCall::Sequence(vec![XCall::ReadClock, XCall::DrawRandom])],
    }
}
fn context() -> XExecutionContext {
    XExecutionContext {
        current_epoch: 7,
        now_ms: 125,
        cancelled: false,
    }
}
fn worker() -> Command {
    let profile = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let path = profile
        .join("examples")
        .join(format!("x_compat_worker{}", std::env::consts::EXE_SUFFIX));
    assert!(
        path.is_file(),
        "build --example x_compat_worker before this test: {}",
        path.display()
    );
    Command::new(path)
}
fn fixture(name: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", name, "--ignored", "--nocapture"]);
    command
}
fn run(
    command: Command,
    budget: XBudget,
    context: impl FnMut() -> XExecutionContext,
) -> Result<XCandidate, XProcessError> {
    evaluate_in_process(
        command,
        true,
        CompatibilityLane::ExperimentalX,
        budget,
        &request(),
        context,
    )
}

#[test]
fn real_worker_round_trip_matches_frozen_hash_and_publication() {
    let first = run(worker(), XBudget::default(), context).unwrap();
    let second = run(worker(), XBudget::default(), context).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        first.request_hash(),
        "3949234e2c2c9f208af935a277dff1bd2f0dd4de504c147d5368ba1b0d480853"
    );
    assert_eq!(
        first.output_hash(),
        "05dde4e6e1f84655ff6662dde75e43b04059cebea550d00aa95d16c06db31437"
    );
    let host = XCompatibilityHost::new(true, XBudget::default()).unwrap();
    assert_eq!(
        host.publish(CompatibilityLane::ExperimentalX, first, context())
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn n0_disabled_and_precancelled_do_not_spawn() {
    for (enabled, lane, ctx, expected) in [
        (
            true,
            CompatibilityLane::NativeN0,
            context(),
            XRejection::NativeN0Isolated,
        ),
        (
            false,
            CompatibilityLane::ExperimentalX,
            context(),
            XRejection::Disabled,
        ),
        (
            true,
            CompatibilityLane::ExperimentalX,
            XExecutionContext {
                cancelled: true,
                ..context()
            },
            XRejection::Cancelled,
        ),
    ] {
        assert_eq!(
            evaluate_in_process(
                Command::new("nonexistent-worker"),
                enabled,
                lane,
                XBudget::default(),
                &request(),
                || ctx
            ),
            Err(XProcessError::Rejected(expected))
        );
    }
}

#[test]
fn crash_bad_receipt_timeout_and_cancel_preserve_last_known_good() {
    let good = run(worker(), XBudget::default(), context).unwrap();
    let mut last_known_good = (0, String::new(), Vec::new());
    publish_result(&mut last_known_good, Ok(good.clone()), context()).unwrap();
    let snapshot = last_known_good.clone();
    assert_eq!(
        publish_result(
            &mut last_known_good,
            run(
                fixture("process_fixture_crash"),
                XBudget::default(),
                context
            ),
            context()
        ),
        Err(XProcessError::Crashed)
    );
    assert_eq!(
        publish_result(
            &mut last_known_good,
            run(
                fixture("process_fixture_bad_receipt"),
                XBudget::default(),
                context
            ),
            context()
        ),
        Err(XProcessError::InvalidReceipt)
    );
    let start = Instant::now();
    assert_eq!(
        publish_result(
            &mut last_known_good,
            run(
                fixture("process_fixture_hang"),
                XBudget {
                    max_wall_clock_ms: 50,
                    ..XBudget::default()
                },
                context
            ),
            context()
        ),
        Err(XProcessError::Rejected(XRejection::WallClockBudgetExceeded))
    );
    assert!(start.elapsed() < Duration::from_secs(2));
    let start = Instant::now();
    assert_eq!(
        publish_result(
            &mut last_known_good,
            run(fixture("process_fixture_hang"), XBudget::default(), || {
                XExecutionContext {
                    cancelled: start.elapsed() > Duration::from_millis(30),
                    ..context()
                }
            }),
            context()
        ),
        Err(XProcessError::Rejected(XRejection::Cancelled))
    );
    assert_eq!(last_known_good, snapshot);
    // 成功回执也不能越过发布时 CAS。
    let host = XCompatibilityHost::new(true, XBudget::default()).unwrap();
    assert_eq!(
        host.publish(
            CompatibilityLane::ExperimentalX,
            good,
            XExecutionContext {
                current_epoch: 8,
                ..context()
            }
        ),
        Err(XRejection::StaleEpoch {
            expected: 7,
            current: 8
        })
    );
}

fn publish_result(
    state: &mut (u64, String, Vec<XMessage>),
    candidate: Result<XCandidate, XProcessError>,
    context: XExecutionContext,
) -> Result<(), XProcessError> {
    let candidate = candidate?;
    let hash = candidate.output_hash().to_owned();
    let host = XCompatibilityHost::new(true, XBudget::default()).unwrap();
    let messages = host
        .publish(CompatibilityLane::ExperimentalX, candidate, context)
        .map_err(XProcessError::Rejected)?;
    *state = (context.current_epoch, hash, messages);
    Ok(())
}

#[test]
fn worker_rejects_unsupported_schema_and_budget() {
    let mut invalid = request();
    invalid.schema_version = 2;
    assert!(
        matches!(evaluate_in_process(worker(), true, CompatibilityLane::ExperimentalX, XBudget::default(), &invalid, context), Err(XProcessError::WorkerRejected(reason)) if reason.contains("UnsupportedSchemaVersion"))
    );
    assert!(
        matches!(run(worker(), XBudget { max_messages: 1, ..XBudget::default() }, context), Err(XProcessError::WorkerRejected(reason)) if reason.contains("MessageBudgetExceeded"))
    );
}

#[test]
fn oversized_and_too_deep_requests_rejected_before_spawn() {
    let mut oversized = request();
    oversized.resources[0].bytes = vec![255; MAX_IPC_BYTES];
    assert_eq!(
        evaluate_in_process(
            Command::new("nonexistent-worker"),
            true,
            CompatibilityLane::ExperimentalX,
            XBudget::default(),
            &oversized,
            context
        ),
        Err(XProcessError::IpcBudgetExceeded)
    );
    let mut deep = request();
    for _ in 0..20 {
        deep.calls = vec![XCall::Sequence(deep.calls)];
    }
    assert_eq!(
        evaluate_in_process(
            Command::new("nonexistent-worker"),
            true,
            CompatibilityLane::ExperimentalX,
            XBudget::default(),
            &deep,
            context
        ),
        Err(XProcessError::Rejected(XRejection::CallDepthExceeded))
    );
}

#[test]
fn epoch_change_terminates_inflight_child() {
    let started = Instant::now();
    assert_eq!(
        run(fixture("process_fixture_hang"), XBudget::default(), || {
            XExecutionContext {
                current_epoch: if started.elapsed() > Duration::from_millis(30) {
                    8
                } else {
                    7
                },
                ..context()
            }
        }),
        Err(XProcessError::Rejected(XRejection::StaleEpoch {
            expected: 7,
            current: 8
        }))
    );
}

#[test]
fn exited_worker_with_inherited_pipe_cannot_block_deadline() {
    let started = Instant::now();
    assert_eq!(
        run(
            fixture("process_fixture_inherited_pipe"),
            XBudget {
                max_wall_clock_ms: 100,
                ..XBudget::default()
            },
            context
        ),
        Err(XProcessError::Rejected(XRejection::WallClockBudgetExceeded))
    );
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
#[ignore = "child-only pipe inheritance injection"]
fn process_fixture_inherited_pipe() {
    let mut command = fixture("process_fixture_hold_pipe");
    let _descendant = command.spawn().unwrap();
    std::process::exit(0);
}

#[test]
#[ignore = "child-only bounded pipe holder"]
fn process_fixture_hold_pipe() {
    std::thread::sleep(Duration::from_millis(800));
}

#[test]
#[ignore = "child-only crash injection"]
fn process_fixture_crash() {
    std::process::exit(17);
}

#[test]
#[ignore = "child-only corrupt IPC injection"]
fn process_fixture_bad_receipt() {
    print!("broken");
}

#[test]
#[ignore = "child-only hang injection"]
fn process_fixture_hang() {
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
