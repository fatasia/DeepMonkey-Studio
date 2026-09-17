#![cfg(windows)]
use std::{path::PathBuf, process::Command};

struct Package(PathBuf);
impl Drop for Package {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn product_scheduler_requires_fixed_worker_and_runs_only_lpac() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("deep-x-scheduler-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let package = Package(directory);
    let player = package.0.join("deep-engine-native.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_deep-engine-native"), &player).unwrap();
    let execute = || {
        Command::new(&player)
            .arg("--verify-x-worker")
            .output()
            .unwrap()
    };
    assert!(
        !execute().status.success(),
        "missing worker must fail closed"
    );
    let worker = package.0.join("deep2d-x-worker.exe");
    std::fs::write(&worker, b"not a Windows executable").unwrap();
    let bad = execute();
    assert!(!bad.status.success());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("CreateProcessW"));
    let test = std::env::current_exe().unwrap();
    let example = test
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/x_compat_worker.exe");
    assert!(
        example.is_file(),
        "build x_compat_worker with static CRT first"
    );
    std::fs::copy(example, worker).unwrap();
    let output = execute();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("X compatibility worker OK: schema=1 messages=2")
    );
    let extra = Command::new(&player)
        .args(["--verify-x-worker", "arbitrary.exe"])
        .output()
        .unwrap();
    assert!(
        !extra.status.success(),
        "CLI cannot accept worker path override"
    );
}
