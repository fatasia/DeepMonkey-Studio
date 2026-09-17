use deep_engine_native::{compat_x::*, runtime_package::*};
use serde_json::{Value, json};

fn fixture() -> Value {
    let mut package: Value =
        serde_json::from_str(include_str!("fixtures/runtime-package-v1.json")).unwrap();
    let request = XRequest {
        schema_version: 1,
        expected_epoch: 7,
        started_at_ms: 100,
        random_seed: 42,
        resources: vec![],
        events: vec![],
        calls: vec![XCall::EmitNumber(42.0)],
    };
    let (index, payload) = freeze_x_resource("x:status", 1, request).unwrap();
    package["schemaVersion"] = json!(6);
    package["materialBindings"] = json!([]);
    package["entrypoints"]["experimentalX"] = json!(index.id);
    package["payloads"]["x:status"] = payload;
    package["resources"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::to_value(index).unwrap());
    package["resources"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    rehash(&mut package);
    package
}
fn rehash(package: &mut Value) {
    let hashes: Vec<_> = package["payloads"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, value)| (id.clone(), runtime_content_sha256(value)))
        .collect();
    for resource in package["resources"].as_array_mut().unwrap() {
        if let Some((_, hash)) = hashes.iter().find(|(id, _)| resource["id"] == *id) {
            resource["contentHash"]["value"] = json!(hash);
        }
    }
    package["packageHash"]["value"] = json!(runtime_package_sha256(package).unwrap());
}
fn load(package: &Value) -> Result<LoadedXRuntimePackage, RuntimePackageError> {
    parse_and_validate_x_runtime_package(&serde_json::to_vec(package).unwrap())
}

#[test]
fn frozen_request_index_and_package_hash_round_trip_and_default_loader_rejects() {
    let package = fixture();
    let loaded = load(&package).unwrap();
    assert_eq!(loaded.resource_id, "x:status");
    assert_eq!(loaded.revision, 1);
    assert_eq!(
        loaded.content.content_hash.value,
        "5c15e6f3d0475b2bdb9952ae31d7d9d9d41f148cd5e6d26656842cb996d3cf3b"
    );
    assert_eq!(loaded.content.request.calls, vec![XCall::EmitNumber(42.0)]);
    assert_eq!(
        loaded.base.resource_index.last().unwrap().kind,
        RuntimeResourceKind::ExperimentalX
    );
    assert!(
        parse_and_validate_runtime_package(&serde_json::to_vec(&package).unwrap())
            .unwrap_err()
            .to_string()
            .contains("explicit experimental X loader")
    );
    assert!(
        parse_and_validate_runtime_package(include_bytes!("fixtures/runtime-package-v1.json"))
            .is_ok()
    );
    assert!(
        parse_and_validate_x_runtime_package(include_bytes!("fixtures/runtime-package-v1.json"))
            .is_err()
    );
    assert_eq!(fixture(), package, "author freeze is deterministic");
}

#[test]
fn outer_rehash_cannot_hide_stale_frozen_request_or_index_identity() {
    for change in 0..8 {
        let mut package = fixture();
        let payload = &mut package["payloads"]["x:status"];
        match change {
            0 => payload["content"]["request"]["randomSeed"] = json!(99),
            1 => payload["revision"] = json!(2),
            2 => payload["id"] = json!("x:other"),
            3 => payload["content"]["lane"] = json!("native-n0"),
            4 => payload["content"]["request"]["script"] = json!("arbitrary()"),
            5 => payload["content"]["workerPath"] = json!("other.exe"),
            6 => payload["schemaVersion"] = json!(2),
            _ => payload["content"]["contentHash"]["algorithm"] = json!("md5"),
        }
        rehash(&mut package);
        assert!(load(&package).is_err(), "mutation {change}");
    }
}

#[test]
fn version_entrypoint_and_unreferenced_index_fail_closed() {
    for change in 0..6 {
        let mut package = fixture();
        match change {
            0 => package["schemaVersion"] = json!(1),
            1 => {
                package["entrypoints"]
                    .as_object_mut()
                    .unwrap()
                    .remove("experimentalX");
            }
            2 => package["entrypoints"]["experimentalX"] = Value::Null,
            3 => package["entrypoints"]["experimentalX"] = json!("scene.main"),
            4 => package["entrypoints"]["experimentalX"] = json!("x:missing"),
            _ => package["entrypoints"]["camera"] = json!("x:status"),
        }
        rehash(&mut package);
        assert!(load(&package).is_err(), "mutation {change}");
    }
    let mut package = fixture();
    package["payloads"]["x:status"]["revision"] = json!(2);
    assert!(load(&package).unwrap_err().to_string().contains("hash"));
}

#[test]
fn author_freeze_rejects_inexact_integers_and_invalid_ir() {
    let request = load(&fixture()).unwrap().content.request;
    for field in 0..4 {
        let mut invalid = request.clone();
        match field {
            0 => invalid.expected_epoch = 9_007_199_254_740_992,
            1 => invalid.random_seed = u64::MAX,
            2 => invalid.started_at_ms = u64::MAX,
            _ => invalid.calls = vec![XCall::EmitNumber(f64::NAN)],
        }
        assert!(freeze_x_resource("x:status", 1, invalid).is_err());
    }
}

#[test]
fn v6_explicitly_rejects_v3_to_v5_roles_even_null_or_unreferenced() {
    for role in ["camera", "chart", "chartSim", "dashboard"] {
        for value in [Value::Null, json!("x:status")] {
            let mut package = fixture();
            package["entrypoints"][role] = value;
            rehash(&mut package);
            assert!(
                load(&package)
                    .unwrap_err()
                    .to_string()
                    .contains("v6 forbids"),
                "{role}"
            );
        }
    }
    for kind in [
        "scene-camera",
        "chart-runtime",
        "chart-sim-runtime",
        "dashboard-runtime",
    ] {
        let mut package = fixture();
        package["payloads"]["z:unexpected"] = json!({});
        package["resources"].as_array_mut().unwrap().push(json!({
            "id":"z:unexpected", "kind":kind, "revision":1,
            "contentHash":{"algorithm":"sha256", "value":""}
        }));
        rehash(&mut package);
        assert!(
            load(&package)
                .unwrap_err()
                .to_string()
                .contains("v6 forbids"),
            "{kind}"
        );
    }
}

#[cfg(windows)]
#[test]
#[ignore = "child-only packaged scheduler fixture"]
fn x_package_worker_fixture() {
    use deep_engine_native::compat_x::{process::*, scheduler::*};
    let loaded = load(&fixture()).unwrap();
    let context = || XExecutionContext {
        current_epoch: 7,
        now_ms: 100,
        cancelled: false,
    };
    assert!(matches!(
        XContentScheduler::default().dispatch(&loaded.content, context),
        Err(XProcessError::Rejected(XRejection::Disabled))
    ));
    let mut scheduler = XContentScheduler::new(XProcessConfig {
        enabled: true,
        ..Default::default()
    })
    .unwrap();
    let old = scheduler
        .dispatch(&loaded.content, context)
        .unwrap()
        .clone();
    assert_eq!(old.messages, vec![XMessage::Number(42.0)]);
    let mut stale = loaded.content.clone();
    stale.request.expected_epoch = 8;
    assert!(scheduler.dispatch(&stale, context).is_err());
    assert_eq!(scheduler.last_known_good(), Some(&old));
}

#[cfg(windows)]
#[test]
fn author_freeze_to_manifest_loader_to_real_lpac_scheduler() {
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("deep-x-package-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let directory = Directory(directory);
    let current = std::env::current_exe().unwrap();
    let player = directory.0.join("package-test.exe");
    std::fs::copy(&current, &player).unwrap();
    let worker = current
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/x_compat_worker.exe");
    std::fs::copy(worker, directory.0.join("deep2d-x-worker.exe")).unwrap();
    let output = std::process::Command::new(player)
        .args([
            "--exact",
            "x_package_worker_fixture",
            "--ignored",
            "--nocapture",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
