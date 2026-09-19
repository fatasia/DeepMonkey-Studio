use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{
    DEEP_2D_RUNTIME_PACKAGE_SCHEMA, DEEP_2D_RUNTIME_PACKAGE_SCHEMA_VERSION, Deep2dAtlasFormat,
    Deep2dAtlasKind, Deep2dCommand, Deep2dIssueCode, Deep2dRuntimeContent, Deep2dRuntimePackage,
    Deep2dValidationResult, decode_display_list,
    runtime_base64::decoded_len,
    runtime_validate_values::{add, finish, validate_id, validate_quad_numbers, validate_revision},
    validate_display_list,
};

const MAX_INPUT_BYTES: usize = 96 * 1024 * 1024;
const MAX_ATLAS_BYTES: usize = 64 * 1024 * 1024;
const MAX_ATLASES: usize = 512;
const MAX_QUADS: usize = 262_144;
const MAX_ATLAS_DIMENSION: u32 = 8_192;

pub fn decode_runtime_content(bytes: &[u8]) -> Result<Deep2dRuntimeContent, String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("Deep2d runtime input exceeds the 96 MiB limit".into());
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid Deep2d runtime JSON: {error}"))?;
    if value.get("schema").is_none() {
        return decode_display_list(bytes).map(Deep2dRuntimeContent::DisplayList);
    }
    let package: Deep2dRuntimePackage = serde_json::from_value(value)
        .map_err(|error| format!("invalid Deep2d runtime package JSON: {error}"))?;
    let result = validate_runtime_package(&package);
    if let Some(issue) = result.issues.first() {
        return Err(format!(
            "invalid Deep2d runtime package: {} at {} ({:?})",
            issue.message, issue.path, issue.code
        ));
    }
    Ok(Deep2dRuntimeContent::Package(package))
}

pub fn validate_runtime_package(package: &Deep2dRuntimePackage) -> Deep2dValidationResult {
    validate_runtime_package_with_atlases(package, None)
}

// Only the preparation path supplies atlases, after an exact comparison against a
// previously successful immutable source in Deep2dPathCache. All other validation remains live.
pub(super) fn validate_runtime_package_with_atlases(
    package: &Deep2dRuntimePackage,
    prepared: Option<&[super::PreparedDeep2dAtlas]>,
) -> Deep2dValidationResult {
    let mut issues = Vec::new();
    if package.schema != DEEP_2D_RUNTIME_PACKAGE_SCHEMA {
        add(
            &mut issues,
            Deep2dIssueCode::InvalidStructure,
            "schema",
            "Unexpected runtime package schema.",
        );
    }
    if !(1..=DEEP_2D_RUNTIME_PACKAGE_SCHEMA_VERSION).contains(&package.schema_version) {
        add(
            &mut issues,
            Deep2dIssueCode::InvalidSchemaVersion,
            "schemaVersion",
            "Expected runtime package schema version 1 or 2.",
        );
    }
    let composition_matches = matches!(
        (package.schema_version, package.composition),
        (1, super::Deep2dComposition::PathThenAtlas) | (2, super::Deep2dComposition::ZOrdered)
    );
    if !composition_matches {
        add(
            &mut issues,
            Deep2dIssueCode::InvalidStructure,
            "composition",
            "Schema v1 requires path-then-atlas; schema v2 requires z-ordered.",
        );
    }
    validate_id(&package.id, "id", &mut issues);
    validate_revision(package.revision, "revision", &mut issues);
    for issue in validate_display_list(&package.display_list).issues {
        add(
            &mut issues,
            issue.code,
            format!("displayList.{}", issue.path),
            issue.message,
        );
    }
    for (index, command) in package.display_list.commands.iter().enumerate() {
        if !matches!(command, Deep2dCommand::Path(_)) {
            add(
                &mut issues,
                Deep2dIssueCode::InvalidStructure,
                format!("displayList.commands[{index}]"),
                "Text and image content must be precompiled into atlas quads.",
            );
        }
    }
    if package.atlases.len() > MAX_ATLASES {
        add(
            &mut issues,
            Deep2dIssueCode::BudgetExceeded,
            "atlases",
            "At most 512 atlases are allowed.",
        );
    }
    if package.quads.len() > MAX_QUADS {
        add(
            &mut issues,
            Deep2dIssueCode::BudgetExceeded,
            "quads",
            "At most 262144 atlas quads are allowed.",
        );
    }
    if package.atlases.len() > MAX_ATLASES || package.quads.len() > MAX_QUADS {
        return finish(issues);
    }

    let mut atlases = HashMap::new();
    let mut total_bytes = 0usize;
    for (index, atlas) in package.atlases.iter().enumerate() {
        let path = format!("atlases[{index}]");
        if validate_id(&atlas.id, &format!("{path}.id"), &mut issues)
            && atlases.insert(atlas.id.as_str(), index).is_some()
        {
            add(
                &mut issues,
                Deep2dIssueCode::DuplicateId,
                format!("{path}.id"),
                "Atlas id must be unique.",
            );
        }
        validate_revision(atlas.revision, &format!("{path}.revision"), &mut issues);
        for (value, name) in [(atlas.width, "width"), (atlas.height, "height")] {
            if value == 0 || value > MAX_ATLAS_DIMENSION {
                add(
                    &mut issues,
                    Deep2dIssueCode::InvalidNumber,
                    format!("{path}.{name}"),
                    "Atlas dimensions must be in 1..=8192.",
                );
            }
        }
        let format_matches = matches!(
            (atlas.kind, atlas.format),
            (Deep2dAtlasKind::Glyph, Deep2dAtlasFormat::R8Unorm)
                | (Deep2dAtlasKind::Image, Deep2dAtlasFormat::Rgba8UnormSrgb)
        );
        if !format_matches {
            add(
                &mut issues,
                Deep2dIssueCode::InvalidStructure,
                format!("{path}.format"),
                "Glyph atlases require r8unorm; image atlases require rgba8unorm-srgb.",
            );
        }
        let expected =
            atlas.width as usize * atlas.height as usize * atlas.format.bytes_per_pixel();
        match prepared.and_then(|values| values.get(index)).map_or_else(
            || decoded_len(&atlas.data_base64),
            |value| Ok(value.data.len()),
        ) {
            Ok(actual) if actual == expected => total_bytes = total_bytes.saturating_add(actual),
            Ok(actual) => add(
                &mut issues,
                Deep2dIssueCode::InvalidStructure,
                format!("{path}.dataBase64"),
                format!("Decoded atlas data has {actual} bytes; expected {expected}."),
            ),
            Err(message) => add(
                &mut issues,
                Deep2dIssueCode::InvalidStructure,
                format!("{path}.dataBase64"),
                message,
            ),
        }
    }
    if total_bytes > MAX_ATLAS_BYTES {
        add(
            &mut issues,
            Deep2dIssueCode::BudgetExceeded,
            "atlases",
            "Decoded atlas data exceeds the 64 MiB resident budget.",
        );
    }

    let mut quad_ids = HashSet::new();
    let mut referenced_atlases = HashSet::new();
    for (index, quad) in package.quads.iter().enumerate() {
        let path = format!("quads[{index}]");
        if validate_id(&quad.id, &format!("{path}.id"), &mut issues)
            && !quad_ids.insert(quad.id.as_str())
        {
            add(
                &mut issues,
                Deep2dIssueCode::DuplicateId,
                format!("{path}.id"),
                "Quad id must be unique.",
            );
        }
        validate_id(&quad.atlas_id, &format!("{path}.atlasId"), &mut issues);
        let Some(&atlas_index) = atlases.get(quad.atlas_id.as_str()) else {
            add(
                &mut issues,
                Deep2dIssueCode::MissingResource,
                format!("{path}.atlasId"),
                "Referenced atlas does not exist.",
            );
            validate_quad_numbers(quad, &path, &mut issues);
            continue;
        };
        referenced_atlases.insert(atlas_index);
        let atlas = &package.atlases[atlas_index];
        let [x, y, width, height] = quad.source;
        if width == 0
            || height == 0
            || x.checked_add(width).is_none_or(|end| end > atlas.width)
            || y.checked_add(height).is_none_or(|end| end > atlas.height)
        {
            add(
                &mut issues,
                Deep2dIssueCode::InvalidNumber,
                format!("{path}.source"),
                "Source rectangle must be non-empty and contained by its atlas.",
            );
        }
        validate_quad_numbers(quad, &path, &mut issues);
    }
    for (index, atlas) in package.atlases.iter().enumerate() {
        if !referenced_atlases.contains(&index) {
            add(
                &mut issues,
                Deep2dIssueCode::InvalidStructure,
                format!("atlases[{index}]"),
                format!(
                    "Atlas {} is unreferenced and would waste resident GPU memory.",
                    atlas.id
                ),
            );
        }
    }
    finish(issues)
}
