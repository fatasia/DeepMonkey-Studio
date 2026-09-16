mod diff;
mod file_read;
mod hash;
mod material_bindings;
mod payloads;
mod prefiltered_ibl;
mod render_packet;
mod types;
mod unique_json;
mod validate;

use std::{fmt, path::Path};

use serde_json::Value;

pub use diff::{
    RuntimeResourceDiffPlan, RuntimeResourcePlanAction, RuntimeResourcePlanEntry,
    plan_runtime_package_diff, plan_runtime_package_resource_diff,
};
use types::RuntimePackageEnvelope;
pub use types::{
    IblEnvironmentReferenceV1, IblReferenceKind, LoadedRuntimePackage, RuntimeContentHash,
    RuntimeEntrypoints, RuntimeMaterialShaderBinding, RuntimePackageSummary,
    RuntimeResourceIndexEntry, RuntimeResourceKind,
};
pub use validate::{runtime_content_sha256, runtime_package_sha256};

pub const DEEP_RUNTIME_PACKAGE_SCHEMA: &str = "deep-engine.runtime-package";
/// Shared duplicate-key/depth-bounded JSON reader for native content envelopes.
pub(crate) fn parse_bounded_json(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    unique_json::parse(bytes)
}
pub const DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION: u32 = 1;
pub const DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION: u32 = 2;
pub const DEEP_RUNTIME_PACKAGE_CAMERA_VERSION: u32 = 3;
/// v4 起 chart/chartSim 入口参与包合同;chart 展示列表与静态 deep2d 互斥。
pub const DEEP_RUNTIME_PACKAGE_CHART_VERSION: u32 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePackageError(String);

impl fmt::Display for RuntimePackageError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(&self.0)
    }
}

impl std::error::Error for RuntimePackageError {}

pub(super) fn fail<T>(message: impl Into<String>) -> Result<T, RuntimePackageError> {
    Err(RuntimePackageError(message.into()))
}

pub fn load_and_validate_runtime_package(
    path: impl AsRef<Path>,
) -> Result<LoadedRuntimePackage, RuntimePackageError> {
    let bytes = read_runtime_package_bytes(path)?;
    parse_and_validate_runtime_package(&bytes)
}

/// Reads a package through the same hard byte bound used by validation. File
/// watchers call this before JSON decoding so a hostile rewrite cannot cause an
/// unbounded `fs::read` allocation on their background thread.
pub fn read_runtime_package_bytes(path: impl AsRef<Path>) -> Result<Vec<u8>, RuntimePackageError> {
    file_read::read(path.as_ref())
}

pub fn parse_and_validate_runtime_package(
    bytes: &[u8],
) -> Result<LoadedRuntimePackage, RuntimePackageError> {
    validate::input_size(bytes)?;
    let value: Value = unique_json::parse(bytes).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package JSON: {error}"))
    })?;
    validate::tree_budget(&value)?;
    let package: RuntimePackageEnvelope = serde_json::from_slice(bytes).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package schema: {error}"))
    })?;
    validate::envelope(&package, &value)?;
    payloads::decode(package)
}
