#![cfg(windows)]
use deep_engine_native::compat_x::{
    process::{lpac::Session, *},
    *,
};
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
};
use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::*};
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn worker() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/x_compat_worker.exe")
}
fn config() -> XProcessConfig {
    XProcessConfig {
        enabled: true,
        budget: XBudget {
            max_wall_clock_ms: 5_000,
            ..Default::default()
        },
        ..Default::default()
    }
}
fn request(epoch: u64) -> XRequest {
    XRequest {
        schema_version: 1,
        expected_epoch: epoch,
        started_at_ms: epoch * 16,
        random_seed: epoch,
        resources: vec![],
        events: vec![XEvent::Key { code: XKey::Enter }],
        calls: vec![
            XCall::ReadClock,
            XCall::DrawRandom,
            XCall::ReadEvent { index: 0 },
        ],
    }
}
fn context(epoch: u64) -> XExecutionContext {
    XExecutionContext {
        current_epoch: epoch,
        now_ms: epoch * 16,
        cancelled: false,
    }
}
fn handle(pid: u32) -> OwnedHandle {
    let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
    assert!(!raw.is_null());
    unsafe { OwnedHandle::from_raw_handle(raw) }
}
fn reclaimed(process: &OwnedHandle) {
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
        WAIT_OBJECT_0
    );
    let prefix = format!("DeepMonkey.X.{}.", std::process::id());
    assert!(
        !std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
    );
}

#[test]
fn one_lpac_process_consumes_fresh_ticks_and_reclaims_on_close() {
    let _lock = LOCK.lock().unwrap();
    let mut session = Session::start(&worker(), config()).unwrap();
    let pid = session.process_id();
    let process = handle(pid);
    let host = XCompatibilityHost::new(true, config().budget).unwrap();
    for epoch in 1..=8 {
        let input = request(epoch);
        let actual = session.evaluate(&input, || context(epoch)).unwrap();
        let expected = host
            .evaluate(CompatibilityLane::ExperimentalX, &input, context(epoch))
            .unwrap();
        assert_eq!(actual, expected);
        assert_eq!(session.process_id(), pid);
        assert_ne!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
    }
    session.close().unwrap();
    session.close().unwrap();
    reclaimed(&process);
    assert!(session.evaluate(&request(9), || context(9)).is_err());
}

#[test]
fn cancellation_timeout_and_worker_rejection_poison_and_reclaim_session() {
    let _lock = LOCK.lock().unwrap();
    for mode in ["cancel", "timeout", "reject"] {
        let mut settings = config();
        if mode == "timeout" {
            settings.budget.max_wall_clock_ms = 10;
        }
        let mut session = Session::start(&worker(), settings).unwrap();
        let process = handle(session.process_id());
        let mut input = request(1);
        if mode == "reject" {
            input.schema_version = 2;
        }
        let mut calls = 0;
        let result = session.evaluate(&input, || {
            calls += 1;
            if mode == "timeout" && calls > 1 {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            XExecutionContext {
                cancelled: mode == "cancel" && calls > 1,
                ..context(1)
            }
        });
        match mode {
            "cancel" => assert!(matches!(
                result,
                Err(XProcessError::Rejected(XRejection::Cancelled))
            )),
            "timeout" => assert!(matches!(
                result,
                Err(XProcessError::Rejected(XRejection::WallClockBudgetExceeded))
            )),
            _ => assert!(matches!(result, Err(XProcessError::WorkerRejected(_)))),
        }
        reclaimed(&process);
        assert!(session.evaluate(&request(2), || context(2)).is_err());
    }
}

#[test]
fn crashed_worker_cannot_be_reused() {
    let _lock = LOCK.lock().unwrap();
    let mut session = Session::start(&worker(), config()).unwrap();
    let process = handle(session.process_id());
    assert_ne!(unsafe { TerminateProcess(process.as_raw_handle(), 3) }, 0);
    assert!(session.evaluate(&request(1), || context(1)).is_err());
    reclaimed(&process);
    assert!(session.evaluate(&request(2), || context(2)).is_err());
}

#[test]
fn crashed_session_is_rebuilt_with_new_pid_and_old_epoch_stays_rejected() {
    let _lock = LOCK.lock().unwrap();
    let host = XCompatibilityHost::new(true, config().budget).unwrap();
    let mut first = Session::start(&worker(), config()).unwrap();
    let first_pid = first.process_id();
    let first_process = handle(first_pid);
    let old = first.evaluate(&request(1), || context(1)).unwrap();
    let published = host
        .publish(CompatibilityLane::ExperimentalX, old.clone(), context(1))
        .unwrap();

    // 强制终止 worker：宿主收到错误且整棵进程树与临时 profile 已回收，会话禁止复用。
    assert_ne!(
        unsafe { TerminateProcess(first_process.as_raw_handle(), 3) },
        0
    );
    assert!(first.evaluate(&request(2), || context(2)).is_err());
    reclaimed(&first_process);

    // 宿主显式重建：新 PID 消费同一封闭请求，输出与本地求值逐字一致；旧 epoch 候选在发布时被拒。
    let mut second = Session::start(&worker(), config()).unwrap();
    let second_process = handle(second.process_id());
    assert_ne!(second.process_id(), first_pid);
    let rebuilt = second.evaluate(&request(2), || context(2)).unwrap();
    assert_eq!(
        rebuilt,
        host.evaluate(CompatibilityLane::ExperimentalX, &request(2), context(2))
            .unwrap()
    );
    let messages = host
        .publish(CompatibilityLane::ExperimentalX, rebuilt, context(2))
        .unwrap();
    assert_eq!(messages.len(), published.len());
    assert_eq!(
        host.publish(CompatibilityLane::ExperimentalX, old, context(2)),
        Err(XRejection::StaleEpoch {
            expected: 1,
            current: 2
        })
    );
    second.close().unwrap();
    reclaimed(&second_process);
}

#[test]
fn bad_receipt_and_oversized_header_reclaim_a_still_running_worker() {
    let _lock = LOCK.lock().unwrap();
    let fault_worker = worker().with_file_name("x_session_fault_worker.exe");
    for epoch in 1..=2 {
        let mut session = Session::start(&fault_worker, config()).unwrap();
        let process = handle(session.process_id());
        let result = session.evaluate(&request(epoch), || context(epoch));
        if epoch == 1 {
            assert!(matches!(result, Err(XProcessError::InvalidReceipt)));
        } else {
            assert!(matches!(result, Err(XProcessError::IpcBudgetExceeded)));
        }
        reclaimed(&process);
        assert!(session.evaluate(&request(3), || context(3)).is_err());
    }
}

#[test]
#[ignore = "explicit local startup amortization measurement"]
fn measure_same_requests_with_and_without_process_reuse() {
    let _lock = LOCK.lock().unwrap();
    let started = std::time::Instant::now();
    let mut expected = Vec::new();
    for epoch in 1..=16 {
        expected
            .push(lpac::evaluate(&worker(), config(), &request(epoch), || context(epoch)).unwrap());
    }
    let single_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let started = std::time::Instant::now();
    let mut session = Session::start(&worker(), config()).unwrap();
    let startup_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let mut ticks = Vec::new();
    for epoch in 1..=16 {
        let tick = std::time::Instant::now();
        let actual = session
            .evaluate(&request(epoch), || context(epoch))
            .unwrap();
        ticks.push(tick.elapsed().as_secs_f64() * 1_000.0);
        assert_eq!(actual, expected[(epoch - 1) as usize]);
    }
    session.close().unwrap();
    println!(
        "{}",
        serde_json::json!({
            "schema": "deep2d.x-session-startup.v1", "ticks": 16,
            "singleProcessPerTickMs": single_ms,
            "sessionIncludingStartupCleanupMs": started.elapsed().as_secs_f64() * 1_000.0,
            "sessionStartupMs": startup_ms, "sessionTickMs": ticks,
        })
    );
}

#[test]
fn disabled_lane_and_request_limit_are_enforced() {
    let _lock = LOCK.lock().unwrap();
    assert!(matches!(
        Session::start(&worker(), XProcessConfig::default()),
        Err(XProcessError::Rejected(XRejection::Disabled))
    ));
    assert!(matches!(
        Session::start(
            &worker(),
            XProcessConfig {
                lane: CompatibilityLane::NativeN0,
                ..config()
            }
        ),
        Err(XProcessError::Rejected(XRejection::NativeN0Isolated))
    ));
    let mut session = Session::start(&worker(), config()).unwrap();
    let process = handle(session.process_id());
    for epoch in 1..=1_024 {
        session
            .evaluate(&request(epoch), || context(epoch))
            .unwrap();
    }
    assert!(
        matches!(session.evaluate(&request(1_025), || context(1_025)), Err(XProcessError::Io(reason)) if reason.contains("request limit"))
    );
    reclaimed(&process);
}
