use std::future::Future;

use serde_json::Value;

use super::{
    LoadedRuntimePackage, RuntimePackageEnvelope, RuntimePackageError, cooperative_hash, fail,
    payloads, render_packet, unique_json, validate,
};
use crate::contract::{PixelLevel, TextureResource};

/// Browser loader: retains all JSON/hash/contract checks, yielding during the
/// large canonical streams and texture decode instead of freezing author input.
pub async fn parse_and_validate_runtime_package_cooperative<F, Fut>(
    bytes: &[u8],
    expected_hash: Option<&str>,
    mut yield_task: F,
) -> Result<LoadedRuntimePackage, RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    validate::input_size(bytes)?;
    if expected_hash.is_some_and(|hash| !super::is_lowercase_sha256(hash)) {
        return fail("expected runtime package hash must be lowercase SHA-256");
    }
    if yield_task().await {
        return fail("scene package preparation cancelled");
    }
    let value = unique_json::parse(bytes).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package JSON: {error}"))
    })?;
    decode_value(value, expected_hash, yield_task).await
}

/// Owned transport bytes are no longer needed once JSON owns its values.
/// Free them before allocating decoded textures and GPU staging copies.
pub async fn parse_and_validate_runtime_package_owned_cooperative<F, Fut>(
    bytes: Vec<u8>,
    expected_hash: Option<&str>,
    mut yield_task: F,
) -> Result<LoadedRuntimePackage, RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    validate::input_size(&bytes)?;
    if expected_hash.is_some_and(|hash| !super::is_lowercase_sha256(hash)) {
        return fail("expected runtime package hash must be lowercase SHA-256");
    }
    if yield_task().await {
        return fail("scene package preparation cancelled");
    }
    let value = unique_json::parse(&bytes).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package JSON: {error}"))
    })?;
    drop(bytes);
    decode_value(value, expected_hash, yield_task).await
}

async fn decode_value<F, Fut>(
    mut value: Value,
    expected_hash: Option<&str>,
    mut yield_task: F,
) -> Result<LoadedRuntimePackage, RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    // unique_json applies node/depth budgets before allocating every node.
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
    let hash = match expected_hash {
        Some(hash) => hash.to_string(),
        None => {
            let declared = root.remove("packageHash");
            let hash = cooperative_hash::hash(&value, &mut yield_task).await?;
            if let Some(declared) = declared {
                value
                    .as_object_mut()
                    .unwrap()
                    .insert("packageHash".into(), declared);
            }
            hash
        }
    };
    if yield_task().await {
        return fail("scene package preparation cancelled");
    }
    let mut package: RuntimePackageEnvelope = serde_json::from_value(value).map_err(|error| {
        RuntimePackageError(format!("invalid Deep Runtime Package schema: {error}"))
    })?;
    validate::envelope_shape(&package, &Value::Object(shape), &hash)?;
    for resource in &package.resources {
        let actual =
            cooperative_hash::hash(&package.payloads[&resource.id], &mut yield_task).await?;
        if actual != resource.content_hash.value {
            return fail(format!(
                "runtime resource {} content hash mismatch",
                resource.id
            ));
        }
    }
    if package.schema_version == super::DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION {
        return fail(
            "runtime package v6 requires the explicit experimental X loader; X is disabled by default",
        );
    }
    payloads::validate_render_environment(&package)?;
    let id = package.entrypoints.render_packet.clone();
    let mut render = package
        .payloads
        .remove(&id)
        .expect("validated payload keys");
    let textures = decode_textures(&mut render, &mut yield_task).await?;
    if yield_task().await {
        return fail("scene package preparation cancelled");
    }
    let prepared = render_packet::decode_owned(&id, render, textures)?;
    if yield_task().await {
        return fail("scene package preparation cancelled");
    }
    payloads::decode_prepared(package, Some(prepared))
}

async fn decode_textures<F, Fut>(
    render: &mut Value,
    yield_task: &mut F,
) -> Result<Option<Vec<TextureResource>>, RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    // Preserve absent/null/invalid collection semantics in the standard decoder.
    if !render.get("textures").is_some_and(Value::is_array) {
        return Ok(None);
    }
    let source = render
        .as_object_mut()
        .unwrap()
        .insert("textures".into(), Value::Array(Vec::new()))
        .unwrap();
    let mut textures = Vec::new();
    let Value::Array(source) = source else {
        unreachable!("texture array")
    };
    for mut value in source {
        let mut mip_data = Vec::new();
        let data = decode_bytes(&mut value, yield_task).await?;
        if let Some(Value::Array(mips)) = value.get_mut("mipmaps") {
            for mip in mips {
                mip_data.push(decode_bytes(mip, yield_task).await?);
            }
        }
        let mut texture: TextureResource = serde_json::from_value(value).map_err(|error| {
            RuntimePackageError(format!("invalid RenderPacket texture: {error}"))
        })?;
        if let Some(data) = data {
            texture.data = data;
        }
        for (PixelLevel { data, .. }, prepared) in texture.mipmaps.iter_mut().zip(mip_data) {
            if let Some(prepared) = prepared {
                *data = prepared;
            }
        }
        textures.push(texture);
        if yield_task().await {
            return fail("scene package preparation cancelled");
        }
    }
    Ok(Some(textures))
}

async fn decode_bytes<F, Fut>(
    value: &mut Value,
    yield_task: &mut F,
) -> Result<Option<Vec<u8>>, RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let Some(Value::String(text)) = value.get("data") else {
        return Ok(None);
    };
    const MAX_BYTES: usize = 128 * 1024 * 1024;
    const CHUNK: usize = 32 * 1024; // Multiple of 4; each chunk has independent canonical padding.
    if text.is_empty() || !text.len().is_multiple_of(4) || text.len() > MAX_BYTES.div_ceil(3) * 4 {
        return fail("invalid or oversized base64 texture data");
    }
    let mut bytes = Vec::with_capacity((text.len() / 4 * 3).min(MAX_BYTES));
    let mut task_started = web_time::Instant::now();
    for chunk in text.as_bytes().chunks(CHUNK) {
        let chunk = std::str::from_utf8(chunk)
            .map_err(|_| RuntimePackageError("invalid base64 texture data".into()))?;
        // '=' before the final chunk is forbidden, even if locally canonical.
        if bytes.len() + chunk.len() / 4 * 3 < text.len() / 4 * 3 && chunk.contains('=') {
            return fail("invalid base64 texture padding");
        }
        bytes.extend(
            crate::deep2d::runtime_base64::decode(chunk)
                .map_err(|error| RuntimePackageError(error.into()))?,
        );
        if bytes.len() > MAX_BYTES {
            return fail("texture data exceeds the 128 MiB packet budget");
        }
        if task_started.elapsed().as_millis() >= 8 {
            if yield_task().await {
                return fail("scene package preparation cancelled");
            }
            task_started = web_time::Instant::now();
        }
    }
    value
        .as_object_mut()
        .unwrap()
        .insert("data".into(), Value::Array(Vec::new()));
    Ok(Some(bytes))
}
