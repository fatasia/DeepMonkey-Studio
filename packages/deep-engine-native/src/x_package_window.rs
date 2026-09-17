use std::path::Path;

#[cfg(windows)]
pub(crate) fn prepare(path: &Path) -> Result<crate::player_content::PlayerContent, String> {
    use deep_engine_native::{
        compat_x::{process::XProcessConfig, scheduler::XContentScheduler, *},
        deep2d::Deep2dRuntimeContent,
    };
    // 呈现过的快照与 headless 求值快照分开，诊断成功不能提升窗口恢复记录。
    let store = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "lkg/local-app-data-unavailable".to_owned())
        .and_then(|root| {
            crate::runtime_lkg::Store::new(
                std::path::PathBuf::from(root).join("DeepEngineNative/x-window-recovery"),
                path,
            )
        });
    let source = crate::x_package_source::load(path, &store)?;
    let mut scheduler = XContentScheduler::new(XProcessConfig {
        enabled: true,
        ..Default::default()
    })
    .map_err(|error| format!("X window scheduler: {error:?}"))?;
    let request = &source.loaded.content.request;
    let published = scheduler
        .dispatch(&source.loaded.content, || XExecutionContext {
            current_epoch: request.expected_epoch,
            now_ms: request.started_at_ms,
            cancelled: false,
        })
        .map_err(|error| format!("X window evaluation failed: {error:?}"))?;
    let display = published
        .display_list()
        .map_err(str::to_owned)?
        .ok_or("X window package must publish a display layer")?
        .clone();
    println!(
        "native X window candidate: {}",
        serde_json::json!({
            "active": source.active, "packageId": source.loaded.base.package_id,
            "epoch": published.epoch, "outputHash": published.output_hash,
            "primaryRejection": source.primary_rejection,
        })
    );
    let hash = source.loaded.base.package_hash.clone();
    let mut content = crate::player_content::PlayerContent::from_package(source.loaded.base)?;
    content.deep2d = Some(Deep2dRuntimeContent::DisplayList(display));
    content.x_template = Some(std::sync::Arc::new(source.loaded.content));
    content.bind_resource_source(path, "x-runtime-file")?;
    if source.active == "primary" {
        match store {
            Ok(store) => {
                content.pending_x_lkg = Some(crate::runtime_lkg::Pending {
                    store,
                    bytes: source.bytes,
                    hash,
                })
            }
            Err(error) => {
                content.startup_notice = Some(format!("X recovery cache unavailable: {error}"))
            }
        }
    } else {
        content.startup_notice = Some("recovered last-known-good X package".into());
    }
    Ok(content)
}

#[cfg(windows)]
pub fn run(path: &Path, smoke: bool) -> Result<(), String> {
    crate::app::run(
        prepare(path)?,
        smoke,
        false,
        false,
        deep_engine_native::bloom::BloomSettings::default(),
    )
}

#[cfg(not(windows))]
pub fn run(_path: &Path, _smoke: bool) -> Result<(), String> {
    Err("X runtime package execution is Windows-only".into())
}
