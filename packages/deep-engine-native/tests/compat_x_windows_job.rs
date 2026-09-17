#![cfg(windows)]
use deep_engine_native::compat_x::{process::*, *};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

fn fixture(name: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", name, "--ignored", "--nocapture"]);
    command
}
fn request() -> XRequest {
    XRequest {
        schema_version: 1,
        expected_epoch: 7,
        started_at_ms: 0,
        random_seed: 1,
        resources: vec![],
        events: vec![],
        calls: vec![],
    }
}
fn assert_exited(pid: u32) {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if !handle.is_null() {
        let status = unsafe { WaitForSingleObject(handle, 1000) };
        unsafe {
            CloseHandle(handle);
        }
        assert_eq!(status, WAIT_OBJECT_0, "descendant {pid} survived job close");
    } else {
        assert_eq!(
            unsafe { GetLastError() },
            ERROR_INVALID_PARAMETER,
            "cannot establish descendant {pid} exit"
        );
    }
}

#[test]
fn cancellation_kills_descendants_after_worker_exits_with_inherited_pipes() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("deep-x-job-tree-{}-{nonce}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let mut command = fixture("job_fixture_root");
    command.current_dir(&directory);
    let started = Instant::now();
    let result = evaluate_in_process(
        command,
        true,
        CompatibilityLane::ExperimentalX,
        XBudget::default(),
        &request(),
        || XExecutionContext {
            current_epoch: 7,
            now_ms: 0,
            cancelled: directory.join("grandchild.pid").exists(),
        },
    );
    assert_eq!(result, Err(XProcessError::Rejected(XRejection::Cancelled)));
    assert!(started.elapsed() < Duration::from_secs(2));
    for name in ["root.pid", "child.pid", "grandchild.pid"] {
        let path = directory.join(name);
        let pid = fs::read_to_string(&path).unwrap().parse().unwrap();
        assert_exited(pid);
        fs::remove_file(path).unwrap();
    }
    fs::remove_dir(directory).unwrap();
}

#[test]
fn worker_self_termination_reaps_live_descendant_tree() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("deep-x-job-crash-{}-{nonce}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let started = Instant::now();
    let mut command = fixture("job_fixture_crash_root");
    command.current_dir(&directory);
    let result = evaluate_with_config(
        command,
        XProcessConfig {
            enabled: true,
            budget: XBudget {
                max_wall_clock_ms: 10_000,
                ..XBudget::default()
            },
            ..Default::default()
        },
        &request(),
        || XExecutionContext {
            current_epoch: 7,
            now_ms: 0,
            cancelled: false,
        },
    );
    assert_eq!(result, Err(XProcessError::Crashed));
    assert!(started.elapsed() < Duration::from_secs(4));
    for name in ["root.pid", "child.pid", "grandchild.pid"] {
        let path = directory.join(name);
        let pid = fs::read_to_string(&path).unwrap().parse().unwrap();
        assert_exited(pid);
        fs::remove_file(path).unwrap();
    }
    fs::remove_dir(directory).unwrap();
}

#[test]
#[ignore = "job tree crash root launched only by parent test"]
fn job_fixture_crash_root() {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;
    assert!(
        fixture("job_fixture_grandchild")
            .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .is_err()
    );
    fs::write("root.pid", std::process::id().to_string()).unwrap();
    let child = fixture("job_fixture_child")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .spawn()
        .unwrap();
    fs::write("child.pid", child.id().to_string()).unwrap();
    // 等整棵树登记完 PID 再以非零码自终止：宿主看到崩溃时子孙仍持有继承管道运行。
    let deadline = Instant::now() + Duration::from_secs(5);
    while !Path::new("grandchild.pid").exists() {
        assert!(Instant::now() < deadline, "descendant tree did not start");
        std::thread::sleep(Duration::from_millis(2));
    }
    std::process::exit(7);
}

#[test]
#[ignore = "job tree root launched only by parent test"]
fn job_fixture_root() {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;
    assert!(
        fixture("job_fixture_grandchild")
            .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .is_err()
    );
    let mut oversized = Vec::<u8>::new();
    assert!(oversized.try_reserve_exact(256 * 1024 * 1024).is_err());
    fs::write("root.pid", std::process::id().to_string()).unwrap();
    let child = fixture("job_fixture_child")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .spawn()
        .unwrap();
    fs::write("child.pid", child.id().to_string()).unwrap();
    std::process::exit(0);
}

#[test]
fn job_user_cpu_budget_terminates_busy_worker_before_wall_deadline() {
    let result = evaluate_with_config(
        fixture("job_fixture_cpu_spin"),
        XProcessConfig {
            enabled: true,
            budget: XBudget {
                max_wall_clock_ms: 6_000,
                ..Default::default()
            },
            process_limits: XProcessLimits {
                job_cpu_time_ms: 50,
                ..Default::default()
            },
            ..Default::default()
        },
        &request(),
        || XExecutionContext {
            current_epoch: 7,
            now_ms: 0,
            cancelled: false,
        },
    );
    assert!(
        matches!(
            result,
            Err(XProcessError::ProcessCpuBudgetExceeded | XProcessError::Crashed)
        ),
        "{result:?}"
    );
}

#[test]
fn active_process_limit_blocks_child_creation() {
    let result = evaluate_with_config(
        fixture("job_fixture_no_children"),
        XProcessConfig {
            enabled: true,
            process_limits: XProcessLimits {
                active_processes: 1,
                ..Default::default()
            },
            ..Default::default()
        },
        &request(),
        || XExecutionContext {
            current_epoch: 7,
            now_ms: 0,
            cancelled: false,
        },
    );
    // 测试入口正常退出但不输出协议JSON，证明内部spawn拒绝断言实际成功。
    assert_eq!(result, Err(XProcessError::InvalidReceipt));
}

#[test]
fn invalid_process_limits_fail_before_spawning() {
    let result = evaluate_with_config(
        Command::new("nonexistent-worker"),
        XProcessConfig {
            enabled: true,
            process_limits: XProcessLimits {
                active_processes: 0,
                ..Default::default()
            },
            ..Default::default()
        },
        &request(),
        || XExecutionContext {
            current_epoch: 7,
            now_ms: 0,
            cancelled: false,
        },
    );
    assert!(
        matches!(result, Err(XProcessError::Io(message)) if message == "invalid X process limits")
    );
}

#[test]
#[ignore = "active process limit injection"]
fn job_fixture_no_children() {
    assert!(fixture("job_fixture_cpu_spin").spawn().is_err());
}

#[test]
#[ignore = "job CPU limit injection"]
fn job_fixture_cpu_spin() {
    let mut value = 1u64;
    loop {
        value = std::hint::black_box(value.wrapping_mul(3).wrapping_add(1));
    }
}

#[test]
#[ignore = "job tree child launched only by root fixture"]
fn job_fixture_child() {
    let mut grandchild = fixture("job_fixture_grandchild")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .spawn()
        .unwrap();
    fs::write("grandchild.pid", grandchild.id().to_string()).unwrap();
    grandchild.wait().unwrap();
}

#[test]
#[ignore = "job tree grandchild launched only by child fixture"]
fn job_fixture_grandchild() {
    assert!(Path::new("root.pid").exists());
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
