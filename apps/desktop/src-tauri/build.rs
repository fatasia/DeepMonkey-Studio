fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_server_profile",
                "set_server_profile",
                "clear_server_profile",
            ]),
        ),
    )
    .expect("failed to build iTwin Studio desktop host");
}
