use std::{fs, path::PathBuf, process::Command};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("native-lkg-cli-{}-{nonce}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn command(&self, mode: &str, source: &str) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
            .args([mode])
            .arg(self.0.join(source))
            .env("LOCALAPPDATA", self.0.join("local"))
            .output()
            .unwrap()
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn text(output: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn preflight_does_not_mark_lkg_and_missing_or_invalid_indices_fail_closed() {
    let folder = Sandbox::new();
    fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime-package-v1.json"),
        folder.0.join("source.json"),
    )
    .unwrap();
    let valid = folder.command("--headless-package", "source.json");
    assert!(valid.status.success(), "{}", text(&valid));
    assert!(!folder.0.join("local").exists());
    fs::write(folder.0.join("source.json"), b"broken").unwrap();
    let invalid = folder.command("--headless-package", "source.json");
    assert!(!invalid.status.success());
    assert!(text(&invalid).contains("lkg/index-unavailable"));
}

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn gpu_present_commits_then_a_new_process_restores_after_source_corruption() {
    let folder = Sandbox::new();
    fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime-package-v1.json"),
        folder.0.join("source.json"),
    )
    .unwrap();
    let first = folder.command("--smoke-package", "source.json");
    assert!(first.status.success(), "{}", text(&first));
    assert!(text(&first).contains("checkpoint committed after present"));
    fs::write(folder.0.join("source.json"), b"broken").unwrap();
    let second = folder.command("--smoke-package", "source.json");
    assert!(second.status.success(), "{}", text(&second));
    assert!(text(&second).contains("\"active\":\"last-known-good\""));
    assert!(!text(&second).contains("checkpoint committed after present"));
    assert!(
        text(&second)
            .contains("native smoke GPU submission complete: scopes=clean callbacks=clean")
    );
    let cache = folder.0.join("local/DeepEngineNative/package-recovery");
    let directory = fs::read_dir(cache).unwrap().next().unwrap().unwrap().path();
    fs::write(directory.join("active.json"), b"{").unwrap();
    let bad_index = folder.command("--headless-package", "source.json");
    assert!(!bad_index.status.success());
    assert!(text(&bad_index).contains("lkg/index-invalid"));
    let blocked = Sandbox::new();
    fs::write(blocked.0.join("local"), b"not a directory").unwrap();
    fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime-package-v1.json"),
        blocked.0.join("source.json"),
    )
    .unwrap();
    let write_failure = blocked.command("--smoke-package", "source.json");
    assert!(write_failure.status.success(), "{}", text(&write_failure));
    assert!(text(&write_failure).contains("checkpoint failed; current scene retained"));
}
