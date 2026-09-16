use std::{ffi::OsString, path::PathBuf};
pub(crate) fn load(path: &std::path::Path) -> Result<crate::player_content::PlayerContent, String> {
    let manifest;
    let path = if path.is_dir() {
        manifest = path.join("manifest.json");
        manifest.as_path()
    } else if cfg!(windows)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("manifest.json"))
    {
        manifest = path.with_file_name("manifest.json");
        manifest.as_path()
    } else {
        path
    };
    let startup = deep_engine_native::asset_package::recovery::load_auto(path)?;
    let loaded = startup.loaded;
    let mut content = crate::player_content::PlayerContent::from_package(loaded.runtime)?;
    content.bind_owned_resource_source(path, "asset-directory", Some(&loaded.package_id))?;
    drop(loaded.snapshot);
    content.pending_asset_lkg = startup.pending;
    content.startup_notice = startup.notice;
    println!(
        "Deep Asset Package directory OK: id={} manifest_hash={} chunks={} bytes={} resource_order={:?}",
        loaded.package_id,
        loaded.manifest_hash,
        loaded.chunk_count,
        loaded.chunk_bytes,
        loaded.resource_order
    );
    Ok(content)
}

pub fn execute(
    command: Option<&str>,
    args: &mut impl Iterator<Item = OsString>,
) -> Option<Result<(), String>> {
    if !matches!(
        command,
        Some("--asset-package" | "--headless-asset-package" | "--smoke-asset-package")
    ) {
        return None;
    }
    Some((|| {
        let path = PathBuf::from(
            args.next()
                .ok_or("asset package requires manifest.json path")?,
        );
        crate::player_cli::reject_extra(args)?;
        let content = load(&path)?;
        if command == Some("--headless-asset-package") {
            return Ok(());
        }
        crate::app::run(
            content,
            command == Some("--smoke-asset-package"),
            false,
            false,
            deep_engine_native::bloom::BloomSettings::default(),
        )
    })())
}
