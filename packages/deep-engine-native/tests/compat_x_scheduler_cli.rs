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
            .env("LOCALAPPDATA", package.0.join("local"))
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
        .env("LOCALAPPDATA", package.0.join("local"))
        .output()
        .unwrap();
    assert!(
        !extra.status.success(),
        "CLI cannot accept worker path override"
    );

    let package_path = package.0.join("runtime-v6.json");
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../deep-engine/fixtures/experimental-x-runtime-v6.json"),
        &package_path,
    )
    .unwrap();
    let executed = Command::new(&player)
        .args(["--headless-x-package", package_path.to_str().unwrap()])
        .env("LOCALAPPDATA", package.0.join("local"))
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    let stdout = String::from_utf8_lossy(&executed.stdout);
    let receipt: serde_json::Value = serde_json::from_str(
        stdout
            .strip_prefix("Deep2D X runtime package OK: ")
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(receipt["packageId"], "x.author");
    assert_eq!(receipt["active"], "primary");
    assert_eq!(receipt["resourceId"], "x:status");
    assert_eq!(
        receipt["messages"],
        serde_json::json!([{"type":"number","data":42.0}])
    );

    let default_loader = Command::new(&player)
        .args(["--headless-package", package_path.to_str().unwrap()])
        .env("LOCALAPPDATA", package.0.join("local"))
        .output()
        .unwrap();
    assert!(
        !default_loader.status.success(),
        "v6 must stay out of the ordinary player route"
    );

    std::fs::write(&package_path, b"broken").unwrap();
    let recovered = Command::new(&player)
        .args(["--headless-x-package", package_path.to_str().unwrap()])
        .env("LOCALAPPDATA", package.0.join("local"))
        .output()
        .unwrap();
    assert!(
        recovered.status.success(),
        "{}",
        String::from_utf8_lossy(&recovered.stderr)
    );
    let recovered_stdout = String::from_utf8_lossy(&recovered.stdout);
    let recovered_receipt: serde_json::Value = serde_json::from_str(
        recovered_stdout
            .strip_prefix("Deep2D X runtime package OK: ")
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(recovered_receipt["active"], "last-known-good");
    assert_eq!(recovered_receipt["messages"], receipt["messages"]);
}
