use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

use deep_engine_native::runtime_package::{runtime_content_sha256, runtime_package_sha256};
use serde_json::{Value, json};

fn run(args: &[&OsStr]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .args(args)
        .output()
        .expect("run native Player CLI")
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime-package-v1.json")
}

fn package() -> Value {
    serde_json::from_slice(&fs::read(fixture()).expect("shared editor export fixture"))
        .expect("runtime package JSON")
}

struct TemporaryPackage(PathBuf);

impl TemporaryPackage {
    fn bytes(bytes: &[u8]) -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "deep-runtime-cli-{}-{}.json",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .expect("create isolated CLI package");
        std::io::Write::write_all(&mut file, bytes).expect("write isolated CLI package");
        Self(path)
    }

    fn json(value: &Value) -> Self {
        Self::bytes(&serde_json::to_vec(value).expect("serialize test package"))
    }
}

impl Drop for TemporaryPackage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn assert_rejected(output: Output, expected: &str) {
    assert!(
        !output.status.success(),
        "rejected package returned success"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(expected), "{stderr}");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Player preflight OK"));
}

fn reseal(value: &mut Value) {
    value["packageHash"]["value"] = json!(runtime_package_sha256(value).expect("package hash"));
}

fn reseal_resource(value: &mut Value, id: &str) {
    let hash = runtime_content_sha256(&value["payloads"][id]);
    let resource = value["resources"]
        .as_array_mut()
        .expect("resources")
        .iter_mut()
        .find(|resource| resource["id"] == id)
        .expect("resource");
    resource["contentHash"]["value"] = json!(hash);
    reseal(value);
}

#[test]
fn headless_player_consumes_the_shared_editor_export_without_a_window() {
    let output = run(&[OsStr::new("--headless-package"), fixture().as_os_str()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value = package();
    assert!(stdout.contains("Deep Runtime Package Player preflight OK"));
    assert!(stdout.contains(value["packageId"].as_str().expect("package id")));
    assert!(stdout.contains(value["packageHash"]["value"].as_str().expect("hash")));
    assert!(stdout.contains("deep2d=true"));
    assert!(stdout.contains("shader_packages=0"));
    assert!(stdout.contains("environment=deep.builtin.studio-ibl.v1"));
    assert!(!stdout.contains("presented"));
}

#[test]
fn package_modes_require_one_path_and_are_mutually_exclusive() {
    for mode in ["--package", "--smoke-package", "--headless-package"] {
        assert_rejected(
            run(&[OsStr::new(mode)]),
            "requires a runtime package JSON path",
        );
        for other in ["--packet", "--smoke-frame", "--help", "--package"] {
            assert_rejected(
                run(&[OsStr::new(mode), OsStr::new(other)]),
                "command modes cannot be combined",
            );
            assert_rejected(
                run(&[OsStr::new(mode), fixture().as_os_str(), OsStr::new(other)]),
                "unexpected argument",
            );
        }
    }
}

#[test]
fn rejects_missing_file_directory_and_malformed_json_before_opening_a_window() {
    let missing = fixture().with_file_name("runtime-package-does-not-exist.json");
    for mode in ["--package", "--smoke-package", "--headless-package"] {
        let output = run(&[OsStr::new(mode), missing.as_os_str()]);
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains(missing.to_string_lossy().as_ref())
        );
        assert_rejected(output, "cannot read");
        assert_rejected(
            run(&[
                OsStr::new(mode),
                fixture().parent().expect("directory").as_os_str(),
            ]),
            "cannot read",
        );
    }
    let malformed = TemporaryPackage::bytes(b"{invalid");
    assert_rejected(
        run(&[OsStr::new("--package"), malformed.0.as_os_str()]),
        "invalid Deep Runtime Package JSON",
    );
}

#[test]
fn rejects_oversized_file_before_json_decoding_or_gpu_creation() {
    let oversized = TemporaryPackage::bytes(b"");
    fs::OpenOptions::new()
        .write(true)
        .open(&oversized.0)
        .expect("open isolated file")
        .set_len(256 * 1024 * 1024 + 1)
        .expect("set oversized length");
    assert_rejected(
        run(&[OsStr::new("--package"), oversized.0.as_os_str()]),
        "256 MiB input limit",
    );
}

#[test]
fn rejects_envelope_and_resource_tampering_through_the_player_entrypoint() {
    let mut value = package();
    value["packageVersion"] = json!("999.0.0");
    let envelope = TemporaryPackage::json(&value);
    assert_rejected(
        run(&[OsStr::new("--package"), envelope.0.as_os_str()]),
        "package hash mismatch",
    );
    let mut value = package();
    let id = value["entrypoints"]["renderPacket"]
        .as_str()
        .expect("entry")
        .to_owned();
    value["payloads"][&id]["materials"][0]["roughness"] = json!(0.987654);
    reseal(&mut value);
    let content = TemporaryPackage::json(&value);
    assert_rejected(
        run(&[OsStr::new("--smoke-package"), content.0.as_os_str()]),
        "content hash mismatch",
    );
}

#[test]
fn unbound_shader_entrypoints_cannot_succeed_as_builtin_pbr() {
    let mut value = package();
    let shader: Value =
        serde_json::from_slice(include_bytes!("fixtures/deep_shader_package_v2.json"))
            .expect("valid shader fixture");
    let id = shader["packageId"]
        .as_str()
        .expect("shader package id")
        .to_owned();
    value["entrypoints"]["shaderPackages"] = json!([id]);
    value["payloads"][&id] = shader;
    value["resources"]
        .as_array_mut()
        .expect("resources")
        .push(json!({
            "id": id, "kind": "shader-package", "revision": 1,
            "contentHash": { "algorithm": "sha256", "value": "0".repeat(64) }
        }));
    value["resources"]
        .as_array_mut()
        .expect("resources")
        .sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    reseal_resource(&mut value, &id);
    let file = TemporaryPackage::json(&value);
    for mode in ["--package", "--smoke-package", "--headless-package"] {
        let output = run(&[OsStr::new(mode), file.0.as_os_str()]);
        assert!(String::from_utf8_lossy(&output.stderr).contains(&id));
        assert_rejected(output, "has no material binding");
    }
}

#[test]
fn absent_deep2d_entry_is_valid_but_invalid_path_geometry_fails_before_gpu_creation() {
    let mut value = package();
    let id = value["entrypoints"]["deep2d"]
        .as_str()
        .expect("Deep2d entry")
        .to_owned();
    value["entrypoints"]["deep2d"] = Value::Null;
    value["payloads"]
        .as_object_mut()
        .expect("payloads")
        .remove(&id);
    value["resources"]
        .as_array_mut()
        .expect("resources")
        .retain(|resource| resource["id"] != id);
    reseal(&mut value);
    let without_deep2d = TemporaryPackage::json(&value);
    let output = run(&[
        OsStr::new("--headless-package"),
        without_deep2d.0.as_os_str(),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("deep2d=false"));

    let mut value = package();
    value["payloads"][&id]["displayList"]["resources"][0]["verbs"]
        .as_array_mut()
        .expect("path verbs")
        .pop();
    reseal_resource(&mut value, &id);
    let unsupported = TemporaryPackage::json(&value);
    assert_rejected(
        run(&[OsStr::new("--package"), unsupported.0.as_os_str()]),
        "UnsupportedGeometry",
    );
}

#[test]
fn help_lists_the_runtime_package_and_portable_probe_entrypoints() {
    let output = run(&[OsStr::new("--help")]);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    for usage in [
        "--package <runtime-package.json>",
        "--smoke-package <runtime-package.json>",
        "--headless-package <runtime-package.json>",
        "--smoke-shadow [render-packet.json]",
        "--smoke-ibl [render-packet.json]",
    ] {
        assert!(stdout.contains(usage), "{stdout}");
    }
}

#[test]
fn differential_probes_accept_explicit_paths_without_falling_back_to_embedded_paths() {
    for mode in ["--smoke-shadow", "--smoke-ibl"] {
        let missing = fixture().with_file_name("explicit-missing-packet.json");
        assert_rejected(
            run(&[OsStr::new(mode), missing.as_os_str()]),
            "explicit-missing-packet.json",
        );
        assert_rejected(
            run(&[
                OsStr::new(mode),
                missing.as_os_str(),
                OsStr::new("--package"),
            ]),
            "unexpected argument",
        );
    }
}
