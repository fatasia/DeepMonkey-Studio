use super::*;
use deep_engine_native::{
    compat_x::{XCall, XMessage, XRequest},
    runtime_package::freeze_x_resource,
};
use std::{
    fs,
    process::Command,
    time::{Duration, Instant},
};

const TEST: &str =
    "app::x_transport::tests::real_worker_rotates_after_1024_ticks_and_faults_do_not_restart";

fn template() -> Arc<XDynamicContent> {
    let request = XRequest {
        schema_version: 1,
        expected_epoch: 0,
        started_at_ms: 0,
        random_seed: 1,
        resources: vec![],
        events: vec![],
        calls: vec![XCall::ReadClock],
    };
    let (_, payload) = freeze_x_resource("x:rotation", 1, request).unwrap();
    Arc::new(serde_json::from_value(payload["content"].clone()).unwrap())
}

fn binding(epoch: u64) -> XTickBinding {
    XTickBinding {
        epoch,
        started_at_ms: epoch,
        random_seed: epoch,
        events: vec![],
    }
}

fn receive(transport: &mut Transport) -> Result<Receipt, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(result) = transport.poll() {
            return result;
        }
        assert!(Instant::now() < deadline, "transport receipt timed out");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn assert_exited(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !process.is_null() {
            let result = WaitForSingleObject(process, 0);
            CloseHandle(process);
            assert_eq!(result, 0, "worker {pid} still alive");
        }
    }
}

#[test]
#[ignore = "requires a static CRT X worker; runs 1025 real isolated ticks"]
fn real_worker_rotates_after_1024_ticks_and_faults_do_not_restart() {
    const CHILD: &str = "DEEP_X_ROTATION_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let executable = std::env::current_exe().unwrap();
        let directory = std::env::temp_dir().join(format!(
            "x-rotation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let child = directory.join("test.exe");
        fs::copy(&executable, &child).unwrap();
        fs::copy(
            executable
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("examples/x_compat_worker.exe"),
            directory.join("deep2d-x-worker.exe"),
        )
        .unwrap();
        let output = Command::new(child)
            .args(["--exact", TEST, "--ignored", "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        fs::remove_dir_all(directory).unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
        return;
    }
    let notifications = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = notifications.clone();
    let mut transport = Transport::start_notified(template(), move || {
        count.fetch_add(1, Ordering::Relaxed);
    })
    .unwrap();
    let mut first_pid = 0;
    let mut last_pid = 0;
    for epoch in 1..=1025 {
        transport.submit(binding(epoch)).unwrap();
        assert!(
            transport.submit(binding(epoch)).is_err(),
            "double dispatch must fail"
        );
        let receipt = receive(&mut transport).unwrap();
        assert_eq!(receipt.output.epoch, epoch);
        assert!(
            matches!(receipt.output.messages.as_slice(), [XMessage::Clock(now)] if *now >= epoch && *now <= epoch + 1000)
        );
        let pid = receipt.process_id.unwrap();
        if epoch == 1 {
            first_pid = pid;
        }
        if epoch <= 1024 {
            assert_eq!(pid, first_pid);
        } else {
            assert_ne!(pid, first_pid);
            assert_exited(first_pid);
        }
        last_pid = pid;
    }
    transport.submit(binding(1026)).unwrap();
    transport.close();
    transport.close();
    assert_exited(last_pid);
    assert!(transport.submit(binding(1027)).is_err());
    assert!(transport.poll().is_none());
    assert!(notifications.load(Ordering::Relaxed) >= 1025);

    let mut bad = (*template()).clone();
    bad.content_hash.value = "invalid".into();
    let mut failed = Transport::start_notified(Arc::new(bad), || {}).unwrap();
    failed.submit(binding(1)).unwrap();
    assert!(receive(&mut failed).unwrap_err().contains("InvalidReceipt"));
    // Join establishes that the failed worker thread cannot accept another request.
    failed.thread.take().unwrap().join().unwrap();
    assert!(failed.submit(binding(2)).is_err());
    failed.close();
    println!(
        "1025 ticks: worker {first_pid} -> {last_pid}; both reclaimed; cancellation and rejection passed"
    );
}
