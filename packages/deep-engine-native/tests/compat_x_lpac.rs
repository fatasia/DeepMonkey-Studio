#![cfg(windows)]
use deep_engine_native::compat_x::{process::*, *};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};
static PROFILE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct CanaryDirectory(PathBuf);
impl Drop for CanaryDirectory {
    fn drop(&mut self) {
        // 路径仅来自本测试独占create_dir，含固定测试数据，不跟随目录枚举删除。
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn example(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples")
        .join(format!("{name}.exe"));
    assert!(path.is_file(), "build --example {name} first");
    path
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
fn context() -> XExecutionContext {
    XExecutionContext {
        current_epoch: 7,
        now_ms: 125,
        cancelled: false,
    }
}
fn assert_no_temp_profile() {
    let prefix = format!("DeepMonkey.X.{}.", std::process::id());
    let leftovers: Vec<_> = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .collect();
    assert!(leftovers.is_empty(), "leftover LPAC scratch directories");
}

#[test]
fn lpac_zero_capability_identity_and_bidirectional_ipc() {
    let _lock = PROFILE_TEST_LOCK.lock().unwrap();
    let request = XRequest {
        schema_version: 1,
        expected_epoch: 7,
        started_at_ms: 100,
        random_seed: 42,
        resources: vec![],
        events: vec![],
        calls: vec![XCall::ReadClock, XCall::DrawRandom],
    };
    let expected = XCompatibilityHost::new(true, config().budget)
        .unwrap()
        .evaluate(CompatibilityLane::ExperimentalX, &request, context())
        .unwrap();
    let actual = lpac::evaluate(&example("x_compat_worker"), config(), &request, context).unwrap();
    assert_eq!(actual, expected);
    // launch只有在父进程核验AppContainer/LPAC/SID/零capabilities后才能恢复线程。
    assert_no_temp_profile();
}

#[test]
fn lpac_denies_real_host_file_and_tcp_with_positive_control() {
    let _lock = PROFILE_TEST_LOCK.lock().unwrap();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("deep-x-canary-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let _cleanup = CanaryDirectory(directory.clone());
    let canary = directory.join("private.txt");
    std::fs::write(&canary, b"host canary unchanged").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let input = serde_json::to_vec(
        &serde_json::json!({"canary":canary,"address":listener.local_addr().unwrap().to_string()}),
    )
    .unwrap();
    let mut control = Command::new(example("x_lpac_probe"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    control.stdin.take().unwrap().write_all(&input).unwrap();
    let output = control.wait_with_output().unwrap();
    assert!(output.status.success());
    let control: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        control,
        serde_json::json!({"readError":null,"writeError":null,"startupError":0,"connectError":null})
    );
    let output = lpac::exchange(&example("x_lpac_probe"), &input, config(), || Ok(())).unwrap();
    let blocked: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(blocked["readError"], 5);
    assert_eq!(blocked["writeError"], 5);
    // 无registryRead时本机WSAStartup=WSASYSCALLFAILURE；不能冒充connect拒绝。
    assert!(
        blocked["startupError"] == 10107
            || (blocked["startupError"] == 0 && blocked["connectError"] == 10013),
        "{blocked}"
    );
    assert!(std::net::TcpStream::connect(listener.local_addr().unwrap()).is_ok());
    assert_eq!(std::fs::read(&canary).unwrap(), b"host canary unchanged");
    std::fs::remove_file(canary).unwrap();
    std::fs::remove_dir(directory).unwrap();
    assert_no_temp_profile();
}

#[test]
fn lpac_invalid_image_and_cancellation_fail_closed_and_cleanup() {
    let _lock = PROFILE_TEST_LOCK.lock().unwrap();
    let missing = example("x_compat_worker").with_extension("missing");
    assert!(matches!(
        lpac::exchange(&missing, b"", config(), || Ok(())),
        Err(XProcessError::Io(_))
    ));
    assert_no_temp_profile();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("deep-x-invalid-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let _cleanup = CanaryDirectory(directory.clone());
    let invalid = directory.join("not-pe.exe");
    std::fs::write(&invalid, b"not a Windows executable").unwrap();
    let rejected = lpac::exchange(&invalid, b"", config(), || Ok(()));
    assert!(
        matches!(rejected, Err(XProcessError::Io(ref message)) if message.contains("CreateProcessW")),
        "{rejected:?}"
    );
    assert_no_temp_profile();
    let mut calls = 0;
    let cancelled = lpac::exchange(&example("x_compat_worker"), b"{}", config(), || {
        calls += 1;
        if calls > 1 {
            Err(XProcessError::Rejected(XRejection::Cancelled))
        } else {
            Ok(())
        }
    });
    assert_eq!(
        cancelled,
        Err(XProcessError::Rejected(XRejection::Cancelled))
    );
    assert_no_temp_profile();
}

#[test]
fn lpac_wall_clock_budget_terminates_worker_and_cleans_scratch() {
    let _lock = PROFILE_TEST_LOCK.lock().unwrap();
    let mut limits = config();
    limits.budget.max_wall_clock_ms = 50;
    let started = std::time::Instant::now();
    let result = lpac::exchange(
        &example("x_lpac_probe"),
        br#"{"mode":"sleep"}"#,
        limits,
        || Ok(()),
    );
    assert_eq!(
        result,
        Err(XProcessError::Rejected(XRejection::WallClockBudgetExceeded))
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert_no_temp_profile();
}
