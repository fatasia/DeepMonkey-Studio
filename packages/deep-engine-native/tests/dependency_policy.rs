use std::{fs, path::Path};

#[test]
fn direct_dependencies_exclude_browser_shells() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(root.join("Cargo.toml"))
        .expect("Cargo.toml")
        .to_lowercase();
    for denied in ["tauri", "wry", "webview", "chromium", "electron", "cef"] {
        assert!(
            !manifest.contains(denied),
            "forbidden browser-shell dependency: {denied}"
        );
    }
    assert!(manifest.contains("wgpu"));
    assert!(manifest.contains("winit"));
    assert!(manifest.contains("default-features = false"));
    for backend in ["\"dx12\"", "\"metal\"", "\"vulkan\""] {
        assert!(
            manifest.contains(backend),
            "missing native GPU backend feature: {backend}"
        );
    }
    for window_backend in ["\"x11\"", "\"wayland\"", "\"wayland-dlopen\""] {
        assert!(
            manifest.contains(window_backend),
            "missing Linux window backend feature: {window_backend}"
        );
    }
    for denied_feature in ["\"gles\"", "\"webgl\"", "\"webgpu\""] {
        assert!(
            !manifest.contains(denied_feature),
            "forbidden wgpu backend feature: {denied_feature}"
        );
    }
}

#[test]
fn native_shaders_are_versioned_and_do_not_embed_javascript() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for (path, contract) in [
        (
            "assets/shaders/native_mesh_v1.wgsl",
            "native mesh shader contract v1",
        ),
        (
            "assets/shaders/native_cascaded_shadow_v1.wgsl",
            "native cascaded shadow sampling contract v1",
        ),
        (
            "assets/shaders/native_gpu_culling_v1.wgsl",
            "native GPU instance culling contract v1",
        ),
        (
            "assets/shaders/native_deep2d_v1.wgsl",
            "native Deep2d painter shader contract v1",
        ),
        (
            "assets/shaders/native_deep2d_atlas_v1.wgsl",
            "native Deep2d atlas shader contract v1",
        ),
        (
            "assets/shaders/native_output_v1.wgsl",
            "native HDR output shader contract v1",
        ),
        (
            "assets/shaders/native_bloom_v1.wgsl",
            "native HDR bloom shader contract v1",
        ),
        (
            "assets/shaders/native_output_bloom_v1.wgsl",
            "native HDR bloom output shader contract v1",
        ),
    ] {
        let shader = fs::read_to_string(root.join(path)).expect("shader");
        assert!(shader.contains(contract), "missing shader contract: {path}");
        for marker in ["<script", "javascript:", "webview", "chromium"] {
            assert!(
                !shader.to_lowercase().contains(marker),
                "unexpected marker in {path}: {marker}"
            );
        }
    }
}
