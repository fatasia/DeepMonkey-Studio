mod hash;
mod material_bindings;
mod payloads;
mod render_packet;
mod types;
mod unique_json;
mod validate;

use std::{fmt, fs::File, io::Read, path::Path};

use serde_json::Value;

use types::RuntimePackageEnvelope;
pub use types::{
    IblEnvironmentReferenceV1, IblReferenceKind, LoadedRuntimePackage, RuntimeContentHash,
    RuntimeEntrypoints, RuntimeMaterialShaderBinding, RuntimePackageSummary,
    RuntimeResourceIndexEntry, RuntimeResourceKind,
};
pub use validate::{runtime_content_sha256, runtime_package_sha256};

pub const DEEP_RUNTIME_PACKAGE_SCHEMA: &str = "deep-engine.runtime-package";
pub const DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION: u32 = 1;
pub const DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION: u32 = 2;

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
    let file = File::open(path.as_ref()).map_err(|error| {
        RuntimePackageError(format!("cannot read {}: {error}", path.as_ref().display()))
    })?;
    if file
        .metadata()
        .is_ok_and(|metadata| metadata.len() > validate::MAX_INPUT_BYTES as u64)
    {
        return fail("Deep Runtime Package exceeds the 256 MiB input limit");
    }
    let mut bytes = Vec::new();
    file.take(validate::MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            RuntimePackageError(format!("cannot read {}: {error}", path.as_ref().display()))
        })?;
    parse_and_validate_runtime_package(&bytes)
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
