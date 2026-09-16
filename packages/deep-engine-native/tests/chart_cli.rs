use std::path::PathBuf;
use std::process::Command;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../deep-engine/fixtures")
        .join(name)
}

#[test]
fn actual_binary_validates_shared_chart_ir_without_starting_a_window() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-chart")
        .arg(fixture("chart-ir-v1.json"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("ChartIR initial state OK: zoom_windows=1 selected=0"));
    assert!(text.contains("ChartIR geometry OK: viewport=640x360 commands="));
    assert!(text.contains("hit_index=ready"));
    assert!(!text.contains("commands=0 "));
    assert!(
        text.contains(
            "ChartIR structure OK: version=1 id=chart-v1-golden series=6 zooms=1 actions=5"
        )
    );
}

#[test]
fn actual_binary_rejects_author_spec_missing_file_and_extra_arguments() {
    assert!(
        fixture("chart-spec-v1.json").is_file(),
        "author-spec rejection requires its real fixture"
    );
    for name in ["chart-spec-v1.json", "missing-chart-ir-file.json"] {
        let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
            .arg("--headless-chart")
            .arg(fixture(name))
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("ChartIR structure OK"));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-chart")
        .arg(fixture("chart-ir-v1.json"))
        .arg("extra")
        .output()
        .unwrap();
    assert!(!output.status.success());
}
