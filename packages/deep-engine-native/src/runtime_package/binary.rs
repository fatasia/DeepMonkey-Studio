use super::{
    LoadedRuntimePackage, RuntimePackageEnvelope, RuntimePackageError, cooperative_hash, fail,
    payloads, render_packet, unique_json, validate,
};
use crate::shader_package::hash::Sha256;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, future::Future};

pub(super) const MAGIC: &[u8; 8] = b"DMPBIN1\n";
const MAX_HEADER: usize = 4 * 1024 * 1024;
const MAX_SECTIONS: usize = 98_304;
const CHUNK: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    schema: String,
    version: u32,
    envelope: Value,
    sections: Vec<Section>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Section {
    path: String,
    encoding: String,
    offset: usize,
    length: usize,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compression: Option<String>,
    #[serde(
        default,
        rename = "decodedLength",
        skip_serializing_if = "Option::is_none"
    )]
    decoded_length: Option<usize>,
}

fn header(bytes: &[u8]) -> Result<(Header, usize), RuntimePackageError> {
    validate::input_size(bytes)?;
    if bytes.len() < 12 || !bytes.starts_with(MAGIC) {
        return fail("invalid binary runtime magic");
    }
    let length = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if length == 0 || length > MAX_HEADER || length > bytes.len() - 12 {
        return fail("invalid binary runtime header length");
    }
    let value = unique_json::parse(&bytes[12..12 + length])
        .map_err(|error| RuntimePackageError(format!("invalid binary runtime JSON: {error}")))?;
    let header: Header = serde_json::from_value(value)
        .map_err(|error| RuntimePackageError(format!("invalid binary runtime header: {error}")))?;
    if header.schema != "deep-engine.runtime-transfer"
        || header.version != 1
        || header.sections.len() > MAX_SECTIONS
    {
        return fail("unsupported or oversized binary runtime profile");
    }
    Ok((header, 12 + length))
}

async fn digest<F, Fut>(bytes: &[u8], yield_task: &mut F) -> Result<String, RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let mut hash = Sha256::new();
    let mut started = web_time::Instant::now();
    for chunk in bytes.chunks(CHUNK) {
        hash.update(chunk);
        if started.elapsed().as_millis() >= 8 {
            if yield_task().await {
                return fail("scene package preparation cancelled");
            }
            started = web_time::Instant::now();
        }
    }
    Ok(hash.finish())
}

fn expected_planes(render: &Value) -> Result<BTreeMap<String, &'static str>, RuntimePackageError> {
    let mut expected = BTreeMap::new();
    let mut plane = |value: &Value, path: String, encoding| -> Result<(), RuntimePackageError> {
        if !value.as_array().is_some_and(Vec::is_empty) {
            return fail("binary runtime requires empty plane placeholders");
        }
        expected.insert(path, encoding);
        Ok(())
    };
    let geometries = render
        .get("geometries")
        .and_then(Value::as_array)
        .ok_or_else(|| RuntimePackageError("binary runtime geometries are missing".into()))?;
    if geometries.len() > 4096 {
        return fail("binary runtime geometry budget exceeded");
    }
    for (index, geometry) in geometries.iter().enumerate() {
        for field in ["vertices", "indices", "uv0", "uv1", "tangents", "colors"] {
            if let Some(value) = geometry.get(field) {
                plane(
                    value,
                    format!("/geometries/{index}/{field}"),
                    if field == "indices" { "u32le" } else { "f32le" },
                )?;
            } else if field == "vertices" || field == "indices" {
                return fail("binary runtime geometry stream is missing");
            }
        }
    }
    if let Some(textures) = render.get("textures") {
        let textures = textures
            .as_array()
            .ok_or_else(|| RuntimePackageError("invalid binary runtime textures".into()))?;
        if textures.len() > 4096 {
            return fail("binary runtime texture budget exceeded");
        }
        for (index, texture) in textures.iter().enumerate() {
            plane(
                texture
                    .get("data")
                    .ok_or_else(|| RuntimePackageError("binary texture plane is missing".into()))?,
                format!("/textures/{index}/data"),
                "rgba8",
            )?;
            if let Some(mips) = texture.get("mipmaps") {
                let mips = mips
                    .as_array()
                    .ok_or_else(|| RuntimePackageError("invalid binary mip levels".into()))?;
                if mips.len() > 15 {
                    return fail("binary mip budget exceeded");
                }
                for (level, mip) in mips.iter().enumerate() {
                    plane(
                        mip.get("data").ok_or_else(|| {
                            RuntimePackageError("binary mip plane is missing".into())
                        })?,
                        format!("/textures/{index}/mipmaps/{level}/data"),
                        "rgba8",
                    )?;
                }
            }
        }
    }
    Ok(expected)
}

async fn inflate<F, Fut>(
    data: &[u8],
    length: usize,
    yield_task: &mut F,
) -> Result<Vec<u8>, RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let mut decoder = flate2::Decompress::new(true);
    let mut output = Vec::with_capacity(length);
    let mut chunk = vec![0; CHUNK];
    let mut started = web_time::Instant::now();
    loop {
        let before_in = decoder.total_in() as usize;
        let before_out = decoder.total_out() as usize;
        let status = decoder
            .decompress(
                &data[before_in..],
                &mut chunk,
                flate2::FlushDecompress::None,
            )
            .map_err(|error| {
                RuntimePackageError(format!("invalid deflate runtime plane: {error}"))
            })?;
        let added = decoder.total_out() as usize - before_out;
        if output.len() + added > length {
            return fail("binary runtime decompression exceeds its declared budget");
        }
        output.extend_from_slice(&chunk[..added]);
        if status == flate2::Status::StreamEnd {
            if output.len() != length || decoder.total_in() as usize != data.len() {
                return fail("binary runtime decompression length or trailing data mismatch");
            }
            return Ok(output);
        }
        if added == 0 && decoder.total_in() as usize == before_in {
            return fail("truncated binary runtime deflate plane");
        }
        if started.elapsed().as_millis() >= 8 {
            if yield_task().await {
                return fail("scene package preparation cancelled");
            }
            started = web_time::Instant::now();
        }
    }
}

/// Byte planes are copied once into their final typed owner. No base64 or giant
/// JSON arrays are ever materialized on the browser input thread.
pub(super) async fn parse_owned<F, Fut>(
    bytes: Vec<u8>,
    expected_hash: Option<&str>,
    mut yield_task: F,
) -> Result<LoadedRuntimePackage, RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    if expected_hash.is_some_and(|hash| !super::is_lowercase_sha256(hash)) {
        return fail("expected binary runtime hash must be lowercase SHA-256");
    }
    if yield_task().await {
        return fail("scene package preparation cancelled");
    }
    let (
        Header {
            mut envelope,
            sections,
            ..
        },
        body,
    ) = header(&bytes)?;
    // The receipt covers the bounded header (including every raw-plane SHA).
    // Each plane is independently checked below, avoiding a second giant scan.
    if let Some(expected) = expected_hash
        && digest(&bytes[..body], &mut yield_task).await? != expected
    {
        return fail("binary runtime transfer hash mismatch");
    }
    let declared = envelope
        .as_object_mut()
        .ok_or_else(|| RuntimePackageError("binary runtime envelope must be an object".into()))?
        .remove("packageHash");
    let package_hash = cooperative_hash::hash(&envelope, &mut yield_task).await?;
    if let Some(declared) = declared {
        envelope
            .as_object_mut()
            .unwrap()
            .insert("packageHash".into(), declared);
    }
    let shape = envelope.clone();
    let mut package: RuntimePackageEnvelope =
        serde_json::from_value(envelope).map_err(|error| {
            RuntimePackageError(format!("invalid binary runtime envelope: {error}"))
        })?;
    validate::envelope_shape(&package, &shape, &package_hash)?;
    if package.schema_version == super::DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION {
        return fail("experimental X is disabled in binary runtime transport");
    }
    for resource in &package.resources {
        let binary_value;
        let value = if resource.id == package.entrypoints.render_packet {
            binary_value = serde_json::json!({ "metadata": package.payloads[&resource.id], "sections": sections });
            &binary_value
        } else {
            &package.payloads[&resource.id]
        };
        if cooperative_hash::hash(value, &mut yield_task).await? != resource.content_hash.value {
            return fail("binary runtime resource hash mismatch");
        }
    }
    let environment = &package.payloads[&package.entrypoints.environment];
    if environment.get("staticLightmap").is_some() {
        return fail("static lightmaps require the JSON runtime transport");
    }
    payloads::validate_render_environment(&package)?;
    let id = package.entrypoints.render_packet.clone();
    let render = package
        .payloads
        .remove(&id)
        .expect("validated payload keys");
    let mut expected = expected_planes(&render)?;
    if sections.len() != expected.len() {
        return fail("binary runtime plane coverage mismatch");
    }
    let mut checked_offset = 0usize;
    let mut decoded_bytes = 0usize;
    let mut texture_bytes = 0usize;
    // Preflight all declarations before reserving decoded pixel storage.
    for section in &sections {
        if expected.remove(&section.path) != Some(section.encoding.as_str()) {
            return fail("binary runtime plane target is invalid or repeated");
        }
        if section.offset != checked_offset
            || section.length == 0
            || section.length > bytes.len() - body - checked_offset
        {
            return fail("binary runtime plane bounds are invalid");
        }
        let length = match (&section.compression, section.decoded_length) {
            (None, None) => section.length,
            (Some(codec), Some(length)) if codec == "deflate" && length > 0 => length,
            _ => return fail("invalid binary runtime compression descriptor"),
        };
        decoded_bytes = decoded_bytes
            .checked_add(length)
            .ok_or_else(|| RuntimePackageError("binary runtime decoded budget overflow".into()))?;
        if decoded_bytes > 256 * 1024 * 1024 {
            return fail("binary runtime decoded budget exceeded");
        }
        if section.encoding == "rgba8" {
            texture_bytes += length;
        }
        if texture_bytes > 128 * 1024 * 1024 {
            return fail("binary runtime texture budget exceeded");
        }
        if section.encoding != "rgba8" && !length.is_multiple_of(4) {
            return fail("binary runtime typed stream is misaligned");
        }
        if !super::is_lowercase_sha256(&section.sha256) {
            return fail("invalid binary runtime plane hash");
        }
        checked_offset += section.length;
    }
    if !expected.is_empty() || body + checked_offset != bytes.len() {
        return fail("binary runtime has missing or trailing planes");
    }
    let mut packet = render_packet::decode_skeleton(&id, render)?;
    let mut offset: usize = 0;
    for section in sections {
        let data = &bytes[body + offset..body + offset + section.length];
        if digest(data, &mut yield_task).await? != section.sha256 {
            return fail("binary runtime plane hash mismatch");
        }
        let decoded = if let Some(length) = section.decoded_length {
            Some(inflate(data, length, &mut yield_task).await?)
        } else {
            None
        };
        let data = decoded.as_deref().unwrap_or(data);
        let parts: Vec<_> = section.path.split('/').skip(1).collect();
        let index: usize = parts[1].parse().expect("checked target");
        if parts[0] == "geometries" {
            let geometry = &mut packet.geometries[index];
            if parts[2] == "indices" {
                let mut values = Vec::with_capacity(data.len() / 4);
                for chunk in data.chunks(CHUNK) {
                    values.extend(
                        chunk
                            .chunks_exact(4)
                            .map(|value| u32::from_le_bytes(value.try_into().unwrap())),
                    );
                    if yield_task().await {
                        return fail("scene package preparation cancelled");
                    }
                }
                geometry.indices = values;
            } else {
                let mut values = Vec::with_capacity(data.len() / 4);
                for chunk in data.chunks(CHUNK) {
                    values.extend(
                        chunk
                            .chunks_exact(4)
                            .map(|value| f32::from_le_bytes(value.try_into().unwrap())),
                    );
                    if yield_task().await {
                        return fail("scene package preparation cancelled");
                    }
                }
                match parts[2] {
                    "vertices" => geometry.vertices = values,
                    "uv0" => geometry.uv0 = Some(values),
                    "uv1" => geometry.uv1 = Some(values),
                    "tangents" => geometry.tangents = Some(values),
                    "colors" => geometry.colors = Some(values),
                    _ => unreachable!("checked geometry target"),
                }
            }
        } else {
            let values = match decoded {
                Some(decoded) => decoded,
                None => {
                    let mut values = Vec::with_capacity(data.len());
                    let mut started = web_time::Instant::now();
                    for chunk in data.chunks(CHUNK) {
                        values.extend_from_slice(chunk);
                        if started.elapsed().as_millis() >= 8 {
                            if yield_task().await {
                                return fail("scene package preparation cancelled");
                            }
                            started = web_time::Instant::now();
                        }
                    }
                    values
                }
            };
            if parts.len() == 3 {
                packet.textures[index].data = values;
            } else {
                packet.textures[index].mipmaps
                    [parts[3].parse::<usize>().expect("checked mip target")]
                .data = values;
            }
        }
        offset += section.length;
    }
    if !expected.is_empty() || body + offset != bytes.len() {
        return fail("binary runtime has missing or trailing planes");
    }
    drop(bytes);
    let summary = crate::contract::validate_packet(&packet)
        .map_err(|error| RuntimePackageError(format!("binary RenderPacket: {error}")))?;
    if yield_task().await {
        return fail("scene package preparation cancelled");
    }
    payloads::decode_prepared(package, Some((packet, summary)))
}
