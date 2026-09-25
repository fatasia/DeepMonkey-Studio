fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_server_profile",
            "set_server_profile",
            "clear_server_profile",
            "get_auth_token",
            "set_auth_token",
            "clear_auth_token",
            "start_local_api",
        ]),
    ))
    .expect("failed to build Deep Monkey Studio desktop host");
}
