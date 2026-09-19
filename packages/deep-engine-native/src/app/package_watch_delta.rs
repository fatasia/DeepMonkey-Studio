//! Resolve a watched delta against the last successfully presented checkpoint.
use std::{borrow::Cow, path::Path};

use deep_engine_native::runtime_package::{
    DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA, RuntimePackageDeltaOutcome, apply_runtime_package_delta,
    parse_and_validate_runtime_package,
};
use serde::Deserialize;

use crate::player_content::RuntimePackageSnapshot;

pub(super) fn resolve<'a>(
    bytes: &'a [u8],
    path: &Path,
    published: &RuntimePackageSnapshot,
) -> Result<Option<Cow<'a, [u8]>>, String> {
    // 仅分派 schema，其余字段不分配 Value；完整预算与合同由既有加载器校验。
    #[derive(Deserialize)]
    struct Header {
        schema: String,
    }
    let header: Header = serde_json::from_slice(bytes)
        .map_err(|error| format!("watched runtime package header invalid: {error}"))?;
    if header.schema != DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA {
        return Ok(Some(Cow::Borrowed(bytes)));
    }
    let baseline = crate::runtime_lkg::Store::local(path)
        .and_then(|store| store.restore())
        .map_err(|error| format!("runtime package delta baseline unavailable: {error}"))?;
    let loaded =
        parse_and_validate_runtime_package(&baseline).map_err(|error| error.to_string())?;
    if loaded.package_id != published.package_id || loaded.package_hash != published.package_hash {
        return Err("runtime package delta baseline unavailable: checkpoint differs from the presented package".into());
    }
    match apply_runtime_package_delta(&baseline, bytes).map_err(|error| error.to_string())? {
        RuntimePackageDeltaOutcome::IdempotentSkip => Ok(None),
        RuntimePackageDeltaOutcome::Applied(applied) => Ok(Some(Cow::Owned(applied.bytes))),
    }
}
