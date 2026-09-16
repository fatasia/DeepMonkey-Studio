use std::process::Command;

#[test]
fn headless_contract_command_verifies_the_golden_without_opening_a_window() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-contract")
        .output()
        .expect("run headless contract command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(stdout.contains("RenderPacket contract OK"));
    assert!(stdout.contains("geometries=2"));
    assert!(stdout.contains("instances=4"));
    assert!(stdout.contains("triangles=13"));
}

#[test]
fn headless_pbr_command_verifies_all_texture_semantics_without_a_window() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-pbr")
        .output()
        .expect("run headless PBR command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(stdout.contains("Native PBR contract OK"));
    assert!(stdout.contains("textures=5"));
    assert!(stdout.contains("mip_levels=10"));
    assert!(stdout.contains("srgb=2"));
    assert!(stdout.contains("linear=3"));
    assert!(stdout.contains("material_bindings=1"));
}

#[test]
fn headless_alpha_command_verifies_batch_policy_without_a_window() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-alpha")
        .output()
        .expect("run headless alpha command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(stdout.contains("Native alpha contract OK"));
    assert!(stdout.contains("opaque_batches=1"));
    assert!(stdout.contains("mask_batches=1"));
    assert!(stdout.contains("blend_batches=2"));
    assert!(stdout.contains("double_sided_batches=2"));
    assert!(stdout.contains("blend_order=[2, 3]"));
}

#[test]
fn unknown_argument_is_rejected_without_opening_a_window() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--unknown")
        .output()
        .expect("run command");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unknown argument"));
}

#[test]
fn help_exposes_the_shader_package_gpu_probe() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--help")
        .output()
        .expect("run help command");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--smoke-shader-package"));
    assert!(stdout.contains("--smoke-deep2d-interleaved"));
    assert!(stdout.contains("--smoke-ibl"));
    assert!(stdout.contains("--smoke-shadow-update"));
    assert!(stdout.contains("--packet-live <render-packet.json>"));
    assert!(stdout.contains("--smoke-packet-live"));
    assert!(stdout.contains("--package-live <runtime-package.json>"));
    assert!(stdout.contains("--smoke-package-live <runtime-package.json>"));
    assert!(stdout.contains("--no-bloom"));
    assert!(stdout.contains("--smoke-no-bloom"));
    assert!(stdout.contains("--headless-fog <density> <r> <g> <b>"));
}

#[test]
fn headless_fog_validates_explicit_parameters_without_opening_a_window() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .args(["--headless-fog", "0.2", "0.1", "0.2", "0.3"])
        .output()
        .expect("run headless fog command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("native fog preflight OK: mode=exponential"));
    assert!(stdout.contains("density=0.2"));
    assert!(stdout.contains("color=[0.1, 0.2, 0.3]"));
}

#[test]
fn headless_fog_rejects_missing_nonfinite_and_unbounded_parameters() {
    for arguments in [
        vec!["--headless-fog", "0.2", "0.1", "0.2"],
        vec!["--headless-fog", "NaN", "0", "0", "0"],
        vec!["--headless-fog", "8.1", "0", "0", "0"],
        vec!["--headless-fog", "0.2", "65", "0", "0"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
            .args(arguments)
            .output()
            .expect("run rejected fog command");
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("fog preflight OK"));
    }
}

#[test]
fn headless_ibl_command_generates_the_deterministic_environment_contract() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-ibl")
        .output()
        .expect("run headless IBL command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(stdout.contains("Native IBL contract OK"));
    assert!(stdout.contains("id=deep.builtin.studio-ibl.v1"));
    assert!(stdout.contains("specular_mips=5"));
    assert!(stdout.contains("specular_texels=2046"));
    assert!(stdout.contains("diffuse_texels=384"));
    assert!(stdout.contains("brdf_texels=1024"));
}

#[test]
fn headless_deep2d_prepares_the_path_only_fixture_without_opening_a_window() {
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-deep2d")
        .output()
        .expect("run headless Deep2d command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(stdout.contains("Deep2d contract/painter OK"));
    assert!(stdout.contains("fill_triangles=4"));
    assert!(stdout.contains("stroke_triangles=2"));
    assert!(stdout.contains("vertices=18"));
}

#[test]
fn headless_deep2d_rejects_unsupported_commands_without_partial_rendering() {
    // Dashes, round caps and round joins are supported now; the v1 fixture
    // still carries text/image direct commands without baked glyphs, which
    // must fail closed with structured issues instead of partial rendering.
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/deep2d_display_list_v1.json");
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-deep2d")
        .arg(fixture)
        .output()
        .expect("run headless Deep2d rejection");
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("utf8 error");
    assert!(stderr.contains("UnsupportedCommand"));
    assert!(stderr.contains("commands[1]"));
}

#[test]
fn headless_deep2d_prepares_the_adaptive_tessellation_smoke_fixture() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/deep2d_tessellated_v1.json");
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-deep2d")
        .arg(fixture)
        .output()
        .expect("run adaptive Deep2d fixture");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(stdout.contains("commands=3"));
    assert!(stdout.contains("fill_triangles=7"));
    assert!(stdout.contains("stroke_triangles=122"));
    assert!(stdout.contains("vertices=387"));
}

#[test]
fn headless_deep2d_prepares_editor_baked_atlas_package() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/deep2d_runtime_atlas_v1.json");
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-deep2d")
        .arg(fixture)
        .output()
        .expect("run headless Deep2d atlas package");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(stdout.contains("atlases=2"));
    assert!(stdout.contains("atlas_bytes=32"));
    assert!(stdout.contains("glyph_quads=2"));
    assert!(stdout.contains("image_quads=1"));
    assert!(stdout.contains("batches=2"));
}

#[test]
fn headless_deep2d_prepares_v2_interleaved_chunks() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/deep2d_runtime_interleaved_v2.json");
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .arg("--headless-deep2d")
        .arg(fixture)
        .output()
        .expect("run headless Deep2d interleaved package");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 output");
    assert!(stdout.contains("glyph_quads=1"));
    assert!(stdout.contains("image_quads=1"));
    assert!(stdout.contains("batches=2"));
    assert!(stdout.contains("chunks=4"));
}
