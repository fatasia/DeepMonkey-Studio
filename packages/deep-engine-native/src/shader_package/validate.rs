use std::collections::HashSet;

use serde_json::Value;

use super::{
    DEEP_PBR_MESH_V1_ID, DEEP_PBR_MESH_V1_SHA256, DEEP_PBR_MESH_V2_ID, DEEP_PBR_MESH_V2_SHA256,
    DEEP_SHADER_PACKAGE_SCHEMA, DEEP_SHADER_PACKAGE_SCHEMA_VERSION, DEEP_SHADER_TARGET_PROFILE,
    DeepShaderPackageV2, ShaderPackageError, fail,
    hash::hash_canonical,
    hash::sha256,
    pipeline,
    primitives::{
        hash, package_id, require_sorted, symbol, valid_hash, validate_entry_points,
        validate_source_map, version,
    },
};

const MAX_INPUT_BYTES: usize = 40 * 1024 * 1024;
const MAX_NODES: usize = 50_000;
const MAX_DEPTH: usize = 24;
const MAX_MODULES: usize = 128;
const MAX_PASSES: usize = 128;
const MAX_DEPENDENCIES: usize = 256;
const MAX_WGSL_BYTES: usize = 1_048_576;
const MAX_TOTAL_WGSL_BYTES: usize = 8_388_608;

pub(super) fn validate_input_size(bytes: &[u8]) -> Result<(), ShaderPackageError> {
    if bytes.len() > MAX_INPUT_BYTES {
        fail("Deep Shader Package exceeds the 40 MiB input limit")
    } else {
        Ok(())
    }
}

pub(super) fn validate_tree_budget(value: &Value) -> Result<(), ShaderPackageError> {
    fn inspect(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), ShaderPackageError> {
        *nodes += 1;
        if *nodes > MAX_NODES || depth > MAX_DEPTH {
            return fail("Deep Shader Package exceeds its node or nesting-depth budget");
        }
        match value {
            Value::Array(items) => items
                .iter()
                .try_for_each(|item| inspect(item, depth + 1, nodes)),
            Value::Object(items) => items
                .values()
                .try_for_each(|item| inspect(item, depth + 1, nodes)),
            _ => Ok(()),
        }
    }
    inspect(value, 0, &mut 0)
}

pub(super) fn validate_package(
    package: &DeepShaderPackageV2,
    value: &Value,
) -> Result<(), ShaderPackageError> {
    validate_header(package)?;
    validate_abi(package)?;
    validate_collections(package)?;

    let dependency_ids: HashSet<_> = package
        .dependencies
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    let module_ids: HashSet<_> = package
        .modules
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    let referenced_dependencies = validate_modules(package, &dependency_ids)?;
    if dependency_ids != referenced_dependencies {
        return fail("dependency is unused or not referenced exactly");
    }
    validate_passes(package, &module_ids)?;

    let mut core = value
        .as_object()
        .ok_or_else(|| ShaderPackageError("package root must be an object".into()))?
        .clone();
    core.remove("packageCacheKey");
    if package.package_cache_key != hash_canonical(&Value::Object(core)) {
        return fail("package cache key mismatch");
    }
    Ok(())
}
fn validate_header(package: &DeepShaderPackageV2) -> Result<(), ShaderPackageError> {
    if package.schema != DEEP_SHADER_PACKAGE_SCHEMA
        || package.schema_version != DEEP_SHADER_PACKAGE_SCHEMA_VERSION
        || package.target_profile != DEEP_SHADER_TARGET_PROFILE
    {
        return fail("unsupported Deep Shader Package schema, version, or target profile");
    }
    if !package_id(&package.package_id)
        || !version(&package.package_version)
        || !version(&package.compiler_version)
        || !hash(&package.package_cache_key)
    {
        return fail("invalid package identifier, version, compiler version, or cache key");
    }
    Ok(())
}

fn validate_abi(package: &DeepShaderPackageV2) -> Result<(), ShaderPackageError> {
    let reference = &package.shader_abi;
    let contract = &reference.contract;
    let fingerprint = match reference.id.as_str() {
        DEEP_PBR_MESH_V1_ID => DEEP_PBR_MESH_V1_SHA256,
        DEEP_PBR_MESH_V2_ID => DEEP_PBR_MESH_V2_SHA256,
        _ => return fail("unsupported shader ABI identity or fingerprint"),
    };
    if !valid_hash(&reference.content_hash)
        || reference.content_hash.value != fingerprint
        || contract.schema != "deep.shader-abi"
        || contract.schema_version != 1
        || contract.id != reference.id
    {
        return fail("unsupported shader ABI identity or fingerprint");
    }
    let value = serde_json::to_value(contract)
        .map_err(|error| ShaderPackageError(format!("shader ABI serialization failed: {error}")))?;
    if hash_canonical(&value) != fingerprint {
        return fail(format!("shader ABI contract differs from {}", reference.id));
    }
    Ok(())
}

fn validate_collections(package: &DeepShaderPackageV2) -> Result<(), ShaderPackageError> {
    if package.dependencies.len() > MAX_DEPENDENCIES
        || package.modules.is_empty()
        || package.modules.len() > MAX_MODULES
        || package.passes.is_empty()
        || package.passes.len() > MAX_PASSES
    {
        return fail("collection budget exceeded or required collection is empty");
    }
    require_sorted(
        package.dependencies.iter().map(|item| item.id.as_str()),
        "dependencies",
    )?;
    require_sorted(
        package.modules.iter().map(|item| item.id.as_str()),
        "modules",
    )?;
    require_sorted(package.passes.iter().map(|item| item.id.as_str()), "passes")?;
    if package
        .dependencies
        .iter()
        .any(|value| !package_id(&value.id) || !valid_hash(&value.content_hash))
    {
        return fail("invalid dependency identifier or content hash");
    }
    Ok(())
}

fn validate_modules<'a>(
    package: &'a DeepShaderPackageV2,
    dependency_ids: &HashSet<&'a str>,
) -> Result<HashSet<&'a str>, ShaderPackageError> {
    let mut referenced = HashSet::new();
    let mut total_wgsl = 0;
    for module in &package.modules {
        total_wgsl += module.source.len();
        if module.language != "wgsl"
            || module.source.len() > MAX_WGSL_BYTES
            || !valid_hash(&module.source_hash)
            || module.source_hash.value != sha256(module.source.as_bytes())
        {
            return fail("module must contain bounded WGSL with its matching SHA-256");
        }
        require_sorted(
            module.dependency_ids.iter().map(String::as_str),
            "module dependencyIds",
        )?;
        for id in &module.dependency_ids {
            if !dependency_ids.contains(id.as_str()) {
                return fail("module references an unknown dependency");
            }
            referenced.insert(id.as_str());
        }
        let identity = serde_json::json!({
            "sourceHash": module.source_hash.value,
            "dependencyIds": module.dependency_ids,
        });
        if module.id != format!("module.{}", hash_canonical(&identity)) {
            return fail("content-addressed module ID mismatch");
        }
    }
    if total_wgsl > MAX_TOTAL_WGSL_BYTES {
        return fail("total WGSL budget exceeded");
    }
    Ok(referenced)
}

fn validate_passes(
    package: &DeepShaderPackageV2,
    module_ids: &HashSet<&str>,
) -> Result<(), ShaderPackageError> {
    let mut used_modules = HashSet::new();
    let mut cache_keys = HashSet::new();
    for pass in &package.passes {
        if pass.id != format!("{}/{}", pass.technique_id, pass.pass_id)
            || !symbol(&pass.technique_id)
            || !symbol(&pass.pass_id)
            || !matches!(pass.kind.as_str(), "forward" | "shadow")
            || !module_ids.contains(pass.module_id.as_str())
            || !hash(&pass.cache_key)
            || !cache_keys.insert(pass.cache_key.as_str())
        {
            return fail("invalid pass identity, kind, module reference, or cache key");
        }
        let module = package
            .modules
            .iter()
            .find(|item| item.id == pass.module_id)
            .expect("module reference checked");
        validate_entry_points(pass, &module.source)?;
        validate_source_map(pass, module.source.split('\n').count())?;
        let execution = pipeline::resolve(&package.shader_abi.contract, pass)?;
        if pass.cache_key != pipeline::expected_cache_key(package, pass, module, &execution)? {
            return fail("pass cache key does not cover its complete executable state");
        }
        used_modules.insert(pass.module_id.as_str());
    }
    if used_modules != *module_ids {
        return fail("module is not referenced by a pass");
    }
    Ok(())
}
