use std::collections::HashSet;

use super::{
    ShaderPackageError, ShaderPackageHash, ShaderPackagePass, fail, wgsl::contains_entry_point,
};

const MAX_SOURCE_MAP: usize = 4_096;

pub(super) fn validate_entry_points(
    pass: &ShaderPackagePass,
    source: &str,
) -> Result<(), ShaderPackageError> {
    if !symbol(&pass.entry_points.vertex)
        || !contains_entry_point(source, "vertex", &pass.entry_points.vertex)
        || pass
            .entry_points
            .fragment
            .as_ref()
            .is_some_and(|name| !symbol(name) || !contains_entry_point(source, "fragment", name))
    {
        fail("pass entry point is missing from executable WGSL tokens")
    } else {
        Ok(())
    }
}

pub(super) fn validate_source_map(
    pass: &ShaderPackagePass,
    line_count: usize,
) -> Result<(), ShaderPackageError> {
    if pass.source_map.len() > MAX_SOURCE_MAP {
        return fail("source-map budget exceeded");
    }
    let mut previous = 0;
    let mut keys = HashSet::new();
    for item in &pass.source_map {
        if !matches!(item.stage.as_str(), "vertex" | "fragment")
            || !symbol(&item.node_id)
            || item.generated_line == 0
            || item.generated_line > (1 << 24)
            || item.generated_line < previous
            || item.generated_line as usize > line_count
            || !keys.insert((item.stage.as_str(), item.node_id.as_str()))
        {
            return fail("invalid, duplicate, or out-of-range source-map entry");
        }
        previous = item.generated_line;
    }
    Ok(())
}

pub(super) fn require_sorted<'a>(
    values: impl Iterator<Item = &'a str>,
    name: &str,
) -> Result<(), ShaderPackageError> {
    let values: Vec<_> = values.collect();
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        fail(format!("{name} must be sorted and unique"))
    } else {
        Ok(())
    }
}

pub(super) fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn valid_hash(value: &ShaderPackageHash) -> bool {
    value.algorithm == "sha256" && hash(&value.value)
}

pub(super) fn symbol(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.is_ascii()
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_alphabetic()
            } else {
                byte.is_ascii_alphanumeric() || byte == b'_'
            }
        })
}

pub(super) fn package_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_lowercase()
            } else {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-".contains(&byte)
            }
        })
}

pub(super) fn version(value: &str) -> bool {
    let (base, suffix) = value
        .split_once('-')
        .map_or((value, None), |(base, suffix)| (base, Some(suffix)));
    let parts: Vec<_> = base.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && suffix.is_none_or(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
        })
}
