use serde_json::{Map, Value, json};

use super::{RuntimePackageError, fail};
use crate::contract::{CONTRACT_SCHEMA, CONTRACT_VERSION, RenderPacket, validate_packet};

pub(super) fn decode(
    id: &str,
    payload: &Value,
) -> Result<(RenderPacket, crate::contract::ContractSummary), RuntimePackageError> {
    let mut value = payload.clone();
    let root = value.as_object_mut().ok_or_else(|| {
        RuntimePackageError(format!("resource {id} RenderPacket must be an object"))
    })?;
    normalize_identity(root, id)?;
    normalize_arrays(root, id)?;
    normalize_emissive(root, id)?;
    let packet: RenderPacket = serde_json::from_value(value).map_err(|error| {
        RuntimePackageError(format!("resource {id} is not a RenderPacket: {error}"))
    })?;
    let summary = validate_packet(&packet)
        .map_err(|error| RuntimePackageError(format!("resource {id}: {error}")))?;
    Ok((packet, summary))
}

fn normalize_identity(root: &mut Map<String, Value>, id: &str) -> Result<(), RuntimePackageError> {
    match root.get("schema") {
        None => {
            root.insert("schema".into(), json!(CONTRACT_SCHEMA));
        }
        Some(Value::String(schema)) if schema == CONTRACT_SCHEMA => {}
        Some(_) => {
            return fail(format!(
                "resource {id} has an unsupported RenderPacket schema"
            ));
        }
    }
    match root.get("version") {
        None => {
            root.insert("version".into(), json!(CONTRACT_VERSION));
        }
        Some(Value::Number(version)) if version.as_u64() == Some(u64::from(CONTRACT_VERSION)) => {}
        Some(_) => {
            return fail(format!(
                "resource {id} has an unsupported RenderPacket version"
            ));
        }
    }
    Ok(())
}

fn normalize_arrays(root: &mut Map<String, Value>, id: &str) -> Result<(), RuntimePackageError> {
    for (collection, fields) in [
        (
            "geometries",
            &["vertices", "uv0", "uv1", "tangents", "indices"][..],
        ),
        ("textures", &["data"][..]),
    ] {
        let Some(Value::Array(resources)) = root.get_mut(collection) else {
            continue;
        };
        for resource in resources {
            let Some(resource) = resource.as_object_mut() else {
                continue;
            };
            for field in fields {
                if let Some(value) = resource.get_mut(*field) {
                    typed_array_to_json_array(value, id, field)?;
                }
            }
            if collection == "textures"
                && let Some(Value::Array(levels)) = resource.get_mut("mipmaps")
            {
                for level in levels {
                    if let Some(data) = level.as_object_mut().and_then(|item| item.get_mut("data"))
                    {
                        typed_array_to_json_array(data, id, "mipmaps.data")?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn typed_array_to_json_array(
    value: &mut Value,
    id: &str,
    field: &str,
) -> Result<(), RuntimePackageError> {
    let Value::Object(values) = value else {
        return Ok(());
    };
    let mut result = Vec::with_capacity(values.len());
    for index in 0..values.len() {
        let key = index.to_string();
        let item = values.get(&key).ok_or_else(|| {
            RuntimePackageError(format!(
                "resource {id} {field} has a sparse typed-array encoding"
            ))
        })?;
        result.push(item.clone());
    }
    if values.keys().any(|key| key.parse::<usize>().is_err()) {
        return fail(format!(
            "resource {id} {field} has an invalid typed-array encoding"
        ));
    }
    *value = Value::Array(result);
    Ok(())
}

fn normalize_emissive(root: &mut Map<String, Value>, id: &str) -> Result<(), RuntimePackageError> {
    let Some(Value::Array(materials)) = root.get_mut("materials") else {
        return Ok(());
    };
    for material in materials {
        let Some(material) = material.as_object_mut() else {
            continue;
        };
        let Some(strength) = material.remove("emissiveStrength") else {
            continue;
        };
        let Some(strength) = strength
            .as_f64()
            .filter(|value| value.is_finite() && (0.0..=256.0).contains(value))
        else {
            return fail(format!("resource {id} has invalid emissiveStrength"));
        };
        let factor = material
            .get("emissiveFactor")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![json!(0.0), json!(0.0), json!(0.0)]);
        if factor.len() != 3 {
            return fail(format!("resource {id} has invalid emissiveFactor"));
        }
        let scaled = factor
            .iter()
            .map(|value| value.as_f64().map(|item| json!(item * strength)))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                RuntimePackageError(format!("resource {id} has invalid emissiveFactor"))
            })?;
        material.insert("emissiveFactor".into(), Value::Array(scaled));
    }
    Ok(())
}
