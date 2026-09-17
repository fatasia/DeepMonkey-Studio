#![cfg(windows)]
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "x-window-cli-{}-{nonce}-{serial}",
            std::process::id()
        ));
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

fn assert_ticks_and_reclaimed_worker(output: &str) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    let ticks: Vec<serde_json::Value> = output
        .lines()
        .filter_map(|line| line.strip_prefix("native X window tick: "))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect();
    assert_eq!(ticks.len(), 3, "{output}");
    let pid = ticks[0]["workerProcessId"].as_u64().unwrap() as u32;
    for (index, tick) in ticks.iter().enumerate() {
        assert_eq!(tick["epoch"], 10 + index as u64);
        assert_eq!(tick["accepted"], 1 + index as u64);
        assert_eq!(tick["workerProcessId"], pid);
        assert_eq!(tick["reusedPresentedLayer"], true);
    }
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !process.is_null() {
            let state = WaitForSingleObject(process, 0);
            CloseHandle(process);
            assert_eq!(state, 0, "window left worker {pid} running");
        }
    }
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
    assert_ticks_and_reclaimed_worker(&first_text);
    assert!(first_text.contains("native X package recovery checkpoint committed after present"));
    assert!(
        first_text.contains("native smoke GPU submission complete: scopes=clean callbacks=clean")
    );
    assert!(first_text.contains("\"active\":\"primary\""));
    fs::write(folder.0.join("source.json"), b"broken").unwrap();
    let restored = folder.execute("--smoke-x-package");
    assert!(restored.status.success(), "{}", text(&restored));
    let restored_text = text(&restored);
    assert_ticks_and_reclaimed_worker(&restored_text);
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

#[test]
#[ignore = "requires a real Windows GPU surface and static CRT X worker"]
fn tick_overflow_fails_without_replacing_the_presented_checkpoint() {
    use deep_engine_native::runtime_package::{freeze_x_resource, runtime_package_sha256};
    let folder = Sandbox::new();
    let mut package: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../deep-engine/fixtures/experimental-x-display-runtime-v6.json"
    ))
    .unwrap();
    let mut request: deep_engine_native::compat_x::XRequest =
        serde_json::from_value(package["payloads"]["x:display"]["content"]["request"].clone())
            .unwrap();
    request.random_seed = 9_007_199_254_740_991;
    let (index, payload) = freeze_x_resource("x:display", 1, request).unwrap();
    package["payloads"]["x:display"] = payload;
    let slot = package["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == "x:display")
        .unwrap();
    *slot = serde_json::to_value(index).unwrap();
    package["packageHash"]["value"] = runtime_package_sha256(&package).unwrap().into();
    fs::write(
        folder.0.join("source.json"),
        serde_json::to_vec(&package).unwrap(),
    )
    .unwrap();
    let failed = folder.execute("--smoke-x-package");
    let output = text(&failed);
    assert!(!failed.status.success(), "{output}");
    assert!(
        output.contains("tick integers must be JSON-safe"),
        "{output}"
    );
    assert!(output.contains("checkpoint committed after present"));
    assert!(!output.contains("native X window tick:"));
    fs::write(folder.0.join("source.json"), b"broken").unwrap();
    let recovered = text(&folder.execute("--smoke-x-package"));
    assert!(recovered.contains("\"active\":\"last-known-good\""));
    assert!(recovered.contains("tick integers must be JSON-safe"));
    assert!(!recovered.contains("checkpoint committed after present"));
}
