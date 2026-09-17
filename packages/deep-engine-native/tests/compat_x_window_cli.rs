#![cfg(windows)]
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("x-window-cli-{}-{nonce}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_deep-engine-native"),
            directory.join("player.exe"),
        )
        .unwrap();
        let worker = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("examples/x_compat_worker.exe");
        fs::copy(worker, directory.join("deep2d-x-worker.exe")).unwrap();
        Self(directory)
    }
    fn source(&self, display: bool) {
        let bytes: &[u8] = if display {
            include_bytes!("../../deep-engine/fixtures/experimental-x-display-runtime-v6.json")
        } else {
            include_bytes!("../../deep-engine/fixtures/experimental-x-runtime-v6.json")
        };
        fs::write(self.0.join("source.json"), bytes).unwrap();
    }
    fn execute(&self, mode: &str) -> Output {
        Command::new(self.0.join("player.exe"))
            .arg(mode)
            .arg(self.0.join("source.json"))
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
fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn headless_checkpoint_and_nonvisual_output_cannot_authorize_window_recovery() {
    let folder = Sandbox::new();
    folder.source(true);
    let headless = folder.execute("--headless-x-package");
    assert!(headless.status.success(), "{}", text(&headless));
    fs::write(folder.0.join("source.json"), b"broken").unwrap();
    let blocked = folder.execute("--smoke-x-package");
    assert!(!blocked.status.success());
    assert!(text(&blocked).contains("lkg/index-unavailable"));
    folder.source(false);
    let invisible = folder.execute("--x-package");
    assert!(!invisible.status.success());
    assert!(text(&invisible).contains("must publish a display layer"));
    assert!(
        !folder
            .0
            .join("local/DeepEngineNative/x-window-recovery")
            .exists()
    );
}

#[test]
#[ignore = "requires a real Windows GPU surface and static CRT X worker"]
fn gpu_present_is_required_before_x_snapshot_can_recover_in_a_new_process() {
    let folder = Sandbox::new();
    folder.source(true);
    let first = folder.execute("--smoke-x-package");
    assert!(first.status.success(), "{}", text(&first));
    let first_text = text(&first);
    assert!(first_text.contains("native X package recovery checkpoint committed after present"));
    assert!(
        first_text.contains("native smoke GPU submission complete: scopes=clean callbacks=clean")
    );
    assert!(first_text.contains("\"active\":\"primary\""));
    fs::write(folder.0.join("source.json"), b"broken").unwrap();
    let restored = folder.execute("--smoke-x-package");
    assert!(restored.status.success(), "{}", text(&restored));
    let restored_text = text(&restored);
    assert!(restored_text.contains("\"active\":\"last-known-good\""));
    assert!(
        restored_text
            .contains("native smoke GPU submission complete: scopes=clean callbacks=clean")
    );
    assert!(!restored_text.contains("checkpoint committed after present"));
    let cache = folder.0.join("local/DeepEngineNative/x-window-recovery");
    let entry = fs::read_dir(cache).unwrap().next().unwrap().unwrap().path();
    fs::write(entry.join("active.json"), b"broken").unwrap();
    let bad = folder.execute("--smoke-x-package");
    assert!(!bad.status.success());
    assert!(text(&bad).contains("lkg/index-invalid"));
}
