use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

struct Job(PathBuf);
impl Job {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "deep-text-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn invalid_text_request_never_creates_or_overwrites_a_result() {
    let job = Job::new();
    let request = job.0.join("request.json");
    let output = job.0.join("result.json");
    fs::write(&request, b"{truncated").unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
            .arg("--rasterize-text")
            .arg(&request)
            .arg("--output")
            .arg(&output)
            .output()
            .unwrap()
    };
    assert!(!run().status.success());
    assert!(!output.exists());
    fs::write(&output, b"previous completed result").unwrap();
    assert!(!run().status.success());
    assert_eq!(fs::read(&output).unwrap(), b"previous completed result");
}

#[test]
fn text_cli_requires_an_explicit_output_and_rejects_extra_arguments() {
    let job = Job::new();
    let request = job.0.join("request.json");
    let output = job.0.join("result.json");
    fs::write(&request, b"{}").unwrap();
    let missing = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--rasterize-text")
        .arg(&request)
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("--output"));
    let extra = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--rasterize-text")
        .arg(&request)
        .arg("--output")
        .arg(&output)
        .arg("extra")
        .output()
        .unwrap();
    assert!(!extra.status.success());
    assert!(!output.exists());
}
