mod abi;
mod execution_plan;
mod executor;
mod gpu_descriptor;
pub(crate) mod hash;
mod pipeline;
mod primitives;
mod validate;
mod wgsl;

use std::{fmt, fs, path::Path};

pub use abi::*;
pub use execution_plan::*;
pub use executor::*;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub const DEEP_SHADER_PACKAGE_SCHEMA: &str = "deep-shader-package";
pub const DEEP_SHADER_PACKAGE_SCHEMA_VERSION: u32 = 2;
pub const DEEP_SHADER_TARGET_PROFILE: &str = "webgpu-wgsl-pipeline-2";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeepShaderPackageV2 {
    pub schema: String,
    pub schema_version: u32,
    pub package_id: String,
    pub package_version: String,
    pub compiler_version: String,
    pub target_profile: String,
    pub shader_abi: ShaderPackageAbiReference,
    pub dependencies: Vec<ShaderPackageDependency>,
    pub modules: Vec<ShaderPackageModule>,
    pub passes: Vec<ShaderPackagePass>,
    pub package_cache_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderPackageAbiReference {
    pub id: String,
    pub content_hash: ShaderPackageHash,
    pub contract: DeepPbrMeshShaderAbi,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderPackageDependency {
    pub id: String,
    pub content_hash: ShaderPackageHash,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShaderPackageHash {
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderPackageModule {
    pub id: String,
    pub language: String,
    pub source: String,
    pub source_hash: ShaderPackageHash,
    pub dependency_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderPackagePass {
    pub id: String,
    pub technique_id: String,
    pub pass_id: String,
    pub kind: String,
    pub module_id: String,
    pub entry_points: ShaderPackageEntryPoints,
    pub source_map: Vec<ShaderSourceMapEntry>,
    pub pipeline: ShaderPackagePipelineSelection,
    pub cache_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShaderPackageEntryPoints {
    pub vertex: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub fragment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderPackagePipelineSelection {
    pub pass_variant_id: String,
    pub attachment_profile_id: String,
    pub alpha_mode: String,
    pub raster_mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderSourceMapEntry {
    pub stage: String,
    pub node_id: String,
    pub generated_line: u32,
}

pub(super) fn deserialize_required_nullable<'de, D, T>(
    deserializer: D,
) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShaderPackageError(String);

impl fmt::Display for ShaderPackageError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(&self.0)
    }
}

impl std::error::Error for ShaderPackageError {}

pub(super) fn fail<T>(message: impl Into<String>) -> Result<T, ShaderPackageError> {
    Err(ShaderPackageError(message.into()))
}

/// Loads and validates an executable-pipeline package without creating GPU objects.
pub fn load_and_validate_shader_package(
    path: impl AsRef<Path>,
) -> Result<DeepShaderPackageV2, ShaderPackageError> {
    let bytes = fs::read(path).map_err(|error| ShaderPackageError(error.to_string()))?;
    parse_and_validate_shader_package(&bytes)
}

/// Parses the v2 contract only; pipeline/device execution is intentionally outside this module.
pub fn parse_and_validate_shader_package(
    bytes: &[u8],
) -> Result<DeepShaderPackageV2, ShaderPackageError> {
    validate::validate_input_size(bytes)?;
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        ShaderPackageError(format!("invalid Deep Shader Package JSON: {error}"))
    })?;
    validate::validate_tree_budget(&value)?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
        return fail("Deep Shader Package v1 is rejected; executable package v2 is required");
    }
    let package: DeepShaderPackageV2 = serde_json::from_slice(bytes).map_err(|error| {
        ShaderPackageError(format!("invalid Deep Shader Package schema: {error}"))
    })?;
    validate::validate_package(&package, &value)?;
    Ok(package)
}
