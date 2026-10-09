mod binary;
mod content_payloads;
mod cooperative;
mod cooperative_hash;
mod dashboard;
mod dashboard_table_types;
mod dashboard_table_validation;
mod dashboard_types;
mod dashboard_video_types;
mod dashboard_video_validation;
pub use dashboard_video_types::*;
#[cfg(windows)]
pub(crate) use dashboard_video_validation::is_mp4_isobmff;
mod dashboard_text_input_types;
pub use dashboard_table_types::*;
pub use dashboard_text_input_types::*;
mod dashboard_validation;
mod delta;
mod delta_manifest;
mod diff;
mod dynamic_animation;
mod dynamic_scene;
mod dynamic_scene_physics;
mod entrypoints;
mod experimental_x;
mod file_read;
mod hash;
mod light_profiles;
mod material_bindings;
mod payloads;
mod prefiltered_ibl;
mod r3_state;
mod render_packet;
mod types;
mod unique_json;
mod validate;
pub use delta::{
    AppliedRuntimePackageDelta, DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA,
    DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA_VERSION, RuntimePackageDeltaOutcome,
    RuntimePackageDeltaRejection, RuntimePackageDeltaRejectionReason, apply_runtime_package_delta,
    build_runtime_package_delta,
};
pub use experimental_x::{
    LoadedXRuntimePackage, freeze_x_resource, parse_and_validate_x_runtime_package,
};

use std::{fmt, path::Path};

use serde_json::Value;

pub use cooperative::{
    parse_and_validate_runtime_package_cooperative,
    parse_and_validate_runtime_package_owned_cooperative,
};
pub use dashboard_types::{
    DashboardFilterDataset, DashboardFilterUpdate, DashboardFrozenFilter, DashboardNode,
    DashboardPage, DashboardRuntimeV1, LoadedDashboard,
};
pub use diff::{
    RuntimeResourceDiffPlan, RuntimeResourcePlanAction, RuntimeResourcePlanEntry,
    plan_runtime_package_diff, plan_runtime_package_resource_diff,
};
pub use dynamic_scene::{
    DynamicAnimationControllerCommand, DynamicAnimationControllerRuntime,
    DynamicAnimationControllerState, DynamicAnimationControllerTransition,
    DynamicAnimationEventMarker, DynamicAnimationKeyframe, DynamicAnimationRuntime,
    DynamicAnimationSample, DynamicAnimationTrack, DynamicDataReplayEvent,
    DynamicDataReplayRuntime, DynamicInteractionRuntime, DynamicSceneRuntime,
    canonical_dynamic_frame, parse_and_validate_dynamic_scene_runtime,
};
pub use dynamic_scene_physics::{
    DynamicGearConstraintRuntime, DynamicPhysicsAutostepRuntime, DynamicPhysicsBodyRuntime,
    DynamicPhysicsCharacterControllerRuntime, DynamicPhysicsColliderRuntime, DynamicPhysicsCommand,
    DynamicPhysicsJointRuntime, DynamicPhysicsLimitsRuntime, DynamicPhysicsMotorRuntime,
    DynamicPhysicsPoseRuntime, DynamicPhysicsPositionMotorRuntime, DynamicPhysicsRuntime,
    DynamicPhysicsSnapToGroundRuntime,
};
pub use light_profiles::{IesSamplingTable, LightIes, LightProfile, ies_max_candela};
pub use r3_state::{
    ClipState, R3_STATE_FRAME_CONTRACT, R3_STATE_OPS_SCHEMA, R3StateBox, R3StateOp, R3StateOps,
    axis_clip_field_from_plane, axis_clip_plane, canonical_r3_state_frame, clip_field,
    parse_and_validate_r3_state_ops, selection_field,
};
use types::RuntimePackageEnvelope;
pub use types::{
    IblEnvironmentReferenceV1, IblReferenceKind, LoadedRuntimePackage, RuntimeContentHash,
    RuntimeEntrypoints, RuntimeMaterialShaderBinding, RuntimeObjectBinding, RuntimePackageSummary,
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
pub const DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION: u32 = 5;
pub const DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION: u32 = 6;
/// v7 adds a first-class dynamic scene runtime resource/entrypoint.
pub const DEEP_RUNTIME_PACKAGE_DYNAMIC_VERSION: u32 = 7;

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
    if bytes.starts_with(binary::MAGIC) {
        return pollster::block_on(binary::parse_owned(bytes.to_vec(), None, || {
            std::future::ready(false)
        }));
    }
    let package = validated_envelope(bytes)?;
    finish_envelope(package)
}

/// Independent canonical re-hash used by the browser compilation worker.
///
/// Runs the exact same parse → budget → remove-`packageHash` → canonical-hash
/// sequence as the verification path, so the value it returns is identical to
/// what `parse_and_validate_runtime_package` would recompute for the same
/// bytes. The main thread can then verify against this value instead of
/// re-walking the whole tree a second time on the input thread.
pub fn compute_runtime_package_canonical_hash(bytes: &[u8]) -> Result<String, RuntimePackageError> {
    if bytes.starts_with(binary::MAGIC) {
        validate::input_size(bytes)?;
        if bytes.len() < 12 {
            return fail("invalid binary runtime header length");
        }
        let length = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        if length == 0 || length > 4 * 1024 * 1024 || length > bytes.len() - 12 {
            return fail("invalid binary runtime header length");
        }
        return Ok(crate::shader_package::hash::sha256(&bytes[..12 + length]));
    }
    validate::input_size(bytes)?;
    let mut value: Value = unique_json::parse(bytes).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package JSON: {error}"))
    })?;
    validate::tree_budget(&value)?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| RuntimePackageError("runtime package root must be an object".into()))?;
    let package_hash = root.remove("packageHash");
    let expected_hash = hash::hash_canonical(&value);
    if let Some(package_hash) = package_hash {
        value
            .as_object_mut()
            .expect("root was an object before packageHash removal")
            .insert("packageHash".into(), package_hash);
    }
    Ok(expected_hash)
}

/// Same strict validation as `parse_and_validate_runtime_package`, but the
/// canonical package hash is supplied by an independent worker-side recompute
/// (via `compute_runtime_package_canonical_hash`) instead of being recomputed
/// on the consuming thread. Every other check — schema, budgets, envelope,
/// hash comparison — is unchanged.
pub fn parse_and_validate_runtime_package_with_expected_hash(
    bytes: &[u8],
    expected_hash: &str,
) -> Result<LoadedRuntimePackage, RuntimePackageError> {
    if bytes.starts_with(binary::MAGIC) {
        return pollster::block_on(binary::parse_owned(
            bytes.to_vec(),
            Some(expected_hash),
            || std::future::ready(false),
        ));
    }
    validate::input_size(bytes)?;
    if !is_lowercase_sha256(expected_hash) {
        return fail("expected runtime package hash must be lowercase SHA-256");
    }
    let mut value: Value = unique_json::parse(bytes).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package JSON: {error}"))
    })?;
    validate::tree_budget(&value)?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| RuntimePackageError("runtime package root must be an object".into()))?;
    let mut shape = serde_json::Map::new();
    if let Some(entrypoints) = root.get("entrypoints") {
        shape.insert("entrypoints".into(), entrypoints.clone());
    }
    if root.contains_key("materialBindings") {
        shape.insert("materialBindings".into(), Value::Null);
    }
    let package_hash = root.remove("packageHash");
    if let Some(package_hash) = package_hash {
        value
            .as_object_mut()
            .expect("root was an object before packageHash removal")
            .insert("packageHash".into(), package_hash);
    }
    let package: RuntimePackageEnvelope = serde_json::from_value(value).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package schema: {error}"))
    })?;
    validate::envelope(&package, &Value::Object(shape), expected_hash)?;
    finish_envelope(package)
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validated_envelope(bytes: &[u8]) -> Result<RuntimePackageEnvelope, RuntimePackageError> {
    validate::input_size(bytes)?;
    let mut value: Value = unique_json::parse(bytes).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package JSON: {error}"))
    })?;
    validate::tree_budget(&value)?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| RuntimePackageError("runtime package root must be an object".into()))?;
    let mut shape = serde_json::Map::new();
    if let Some(entrypoints) = root.get("entrypoints") {
        shape.insert("entrypoints".into(), entrypoints.clone());
    }
    if root.contains_key("materialBindings") {
        shape.insert("materialBindings".into(), Value::Null);
    }
    // The unique-field parser owns this tree. Hash the original core without a
    // second full payload clone, then move that same tree into the typed schema.
    let package_hash = root.remove("packageHash");
    let expected_hash = hash::hash_canonical(&value);
    if let Some(package_hash) = package_hash {
        value
            .as_object_mut()
            .unwrap()
            .insert("packageHash".into(), package_hash);
    }
    let package: RuntimePackageEnvelope = serde_json::from_value(value).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package schema: {error}"))
    })?;
    validate::envelope(&package, &Value::Object(shape), &expected_hash)?;
    Ok(package)
}

fn finish_envelope(
    package: RuntimePackageEnvelope,
) -> Result<LoadedRuntimePackage, RuntimePackageError> {
    if package.schema_version == DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION {
        return fail(
            "runtime package v6 requires the explicit experimental X loader; X is disabled by default",
        );
    }
    payloads::decode(package)
}
