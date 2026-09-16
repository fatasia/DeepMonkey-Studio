use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

fn run(args: &[&OsStr]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .args(args)
        .output()
        .expect("run native Player CLI")
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime-package-v1.json")
}

struct TemporaryPackage(PathBuf);

impl TemporaryPackage {
    fn new(bytes: &[u8]) -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "deep-startup-recovery-{}-{}.json",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&path, bytes).expect("write temporary package");
        Self(path)
    }

    fn replace(&self, bytes: &[u8]) {
        fs::write(&self.0, bytes).expect("replace temporary package");
    }
}

impl Drop for TemporaryPackage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn assert_paths_redacted(output: &Output, primary: &Path, fallback: &Path) {
    let diagnostic = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for path in [primary, fallback] {
        assert!(
            !diagnostic.contains(&path.to_string_lossy().to_string()),
            "diagnostic exposed runtime package path: {diagnostic}"
        );
    }
    assert!(!diagnostic.contains("primaryPath"), "{diagnostic}");
    assert!(!diagnostic.contains("lastKnownGoodPath"), "{diagnostic}");
}

#[test]
fn corrupt_primary_uses_read_only_last_known_good_then_accepts_repaired_primary() {
    let valid = fs::read(fixture()).expect("read fixture");
    let primary = TemporaryPackage::new(b"{");
    let fallback = TemporaryPackage::new(&valid);
    let fallback_before = fs::read(&fallback.0).expect("fallback before");

    let recovered = run(&[
        OsStr::new("--headless-package-recover"),
        primary.0.as_os_str(),
        fallback.0.as_os_str(),
    ]);
    assert!(
        recovered.status.success(),
        "{}",
        String::from_utf8_lossy(&recovered.stderr)
    );
    let report = stdout(&recovered);
    assert!(report.contains("\"code\":\"primary-rejected\""), "{report}");
    assert!(
        report.contains("\"active\":\"last-known-good\""),
        "{report}"
    );
    assert!(
        report.contains("invalid Deep Runtime Package JSON"),
        "{report}"
    );
    assert_eq!(
        fs::read(&fallback.0).expect("fallback after"),
        fallback_before
    );
    assert_paths_redacted(&recovered, &primary.0, &fallback.0);

    primary.replace(&valid);
    let retried = run(&[
        OsStr::new("--headless-package-recover"),
        primary.0.as_os_str(),
        fallback.0.as_os_str(),
    ]);
    assert!(retried.status.success());
    let report = stdout(&retried);
    assert!(report.contains("\"code\":\"primary-accepted\""), "{report}");
    assert!(report.contains("\"active\":\"primary\""), "{report}");
    assert_paths_redacted(&retried, &primary.0, &fallback.0);
}

#[test]
fn corrupt_primary_and_fallback_fail_closed_with_machine_diagnostic() {
    let primary = TemporaryPackage::new(b"{");
    let fallback = TemporaryPackage::new(b"[]");
    let output = run(&[
        OsStr::new("--headless-package-recover"),
        primary.0.as_os_str(),
        fallback.0.as_os_str(),
    ]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("\"code\":\"no-valid-runtime-package\""),
        "{error}"
    );
    assert!(error.contains("\"active\":\"none\""), "{error}");
    assert!(error.contains("primaryRejection"), "{error}");
    assert!(error.contains("lastKnownGoodRejection"), "{error}");
    assert_paths_redacted(&output, &primary.0, &fallback.0);
}

#[test]
fn recovery_modes_require_two_paths_and_reject_extra_arguments() {
    for mode in ["--package-recover", "--headless-package-recover"] {
        let missing = run(&[OsStr::new(mode), fixture().as_os_str()]);
        assert!(!missing.status.success());
        assert!(String::from_utf8_lossy(&missing.stderr).contains("requires a runtime package"));
        let extra = run(&[
            OsStr::new(mode),
            fixture().as_os_str(),
            fixture().as_os_str(),
            OsStr::new("--help"),
        ]);
        assert!(!extra.status.success());
        assert!(String::from_utf8_lossy(&extra.stderr).contains("unexpected argument"));
    }
}
