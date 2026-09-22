//! Frozen font provenance and test face selection.
use super::*;

/// 读取冻结字体清单并加载字节（from_frozen_fonts 内部会重新校验 SHA-256）。
pub(super) fn load_frozen_fonts(fonts_dir: &Path) -> Result<(Vec<FrozenFontInput>, Value), String> {
    let manifest_path = fonts_dir.join("fonts.json");
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("read {}: {error}", manifest_path.display()))?;
    let parsed: Value =
        serde_json::from_str(&manifest).map_err(|error| format!("parse fonts.json: {error}"))?;
    let entries = parsed.as_array().ok_or("fonts.json must be an array")?;
    let mut inputs = Vec::new();
    let mut provenance = Vec::new();
    for entry in entries {
        let id = entry["id"].as_str().ok_or("font id missing")?.to_string();
        let path = entry["path"].as_str().ok_or("font path missing")?;
        let source = entry["source"].as_str().unwrap_or_default();
        let sha = source
            .split("sha256=")
            .nth(1)
            .map(|rest| {
                rest.split([';', ','])
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string()
            })
            .ok_or_else(|| format!("font {id}: sha256 missing in source"))?;
        if sha.len() != 64
            || !sha
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(format!("font {id}: malformed sha256 {sha:?}"));
        }
        let bytes = std::fs::read(path).map_err(|error| format!("read font {id}: {error}"))?;
        inputs.push(FrozenFontInput {
            bytes,
            sha256: sha.clone(),
            face_index: 0,
        });
        provenance.push(json!({
            "id": id,
            "path": path,
            "sha256": sha,
            "weight": entry["layoutFace"]["weight"],
            "family": entry["layoutFace"]["family"],
        }));
    }
    if inputs.len() < 2 {
        return Err("fonts.json must provide regular and bold faces".into());
    }
    Ok((inputs, Value::Array(provenance)))
}

pub(super) fn sha_for_weight(provenance: &Value, weight: u64) -> Result<String, String> {
    for entry in provenance.as_array().expect("provenance array") {
        if entry["weight"].as_u64() == Some(weight) {
            return Ok(entry["sha256"].as_str().expect("sha").to_string());
        }
    }
    Err(format!("no frozen face with weight {weight}"))
}

pub(super) enum FontSpec {
    System {
        id: &'static str,
        text: &'static str,
        family: &'static str,
    },
    Frozen {
        id: &'static str,
        text: String,
        sha256: String,
        weight: u16,
    },
}
