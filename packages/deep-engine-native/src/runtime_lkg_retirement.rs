//! Retain active and previous snapshots; retire only verified generated files after commit.
use super::*;

pub(super) fn verified_size(path: &Path, hash: &str) -> Option<u64> {
    check_components(path).ok()?;
    let bytes = read_runtime_package_bytes(path).ok()?;
    let package = parse_and_validate_runtime_package(&bytes).ok()?;
    (package.package_hash == hash).then_some(bytes.len() as u64)
}

pub(super) fn budget(
    existing: Option<u64>,
    candidate: u64,
    previous: Option<u64>,
) -> Result<(), String> {
    // Only newly staged bytes count as an addition; reused bytes are counted once.
    let additional = if existing.is_some() { 0 } else { candidate };
    let retained = existing
        .unwrap_or(0)
        .saturating_add(additional)
        .saturating_add(previous.unwrap_or(0));
    if retained > 512 * 1024 * 1024 {
        Err("lkg/cache-budget".into())
    } else {
        Ok(())
    }
}

pub(super) fn retire(store: &Store, active: &str, previous: Option<&str>) {
    let directory = store.directory();
    let Ok(entries) = fs::read_dir(&directory) else {
        return;
    };
    // Legacy directories may contain 128 old versions. Bound each maintenance pass.
    for entry in entries.take(256).flatten() {
        let path = entry.path();
        let Some(hash) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        if path.extension().and_then(|name| name.to_str()) != Some("json")
            || !valid_hash(hash)
            || hash == active
            || previous == Some(hash)
            || path.to_string_lossy().to_lowercase() == store.source
        {
            continue;
        }
        if verified_size(&path, hash).is_none() {
            continue;
        }
        // Recheck authority and path immediately before deleting a generated snapshot.
        if store.active_hash().as_deref() != Ok(active) {
            return;
        }
        if check_components(&path).is_ok()
            && fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file())
            && let Err(error) = fs::remove_file(&path)
        {
            eprintln!("lkg/retirement-deferred: {}", error.kind());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_hash_is_counted_once_at_budget_boundary() {
        let mib = 1024 * 1024;
        assert!(budget(Some(300 * mib), 300 * mib, None).is_ok());
        assert!(budget(Some(256 * mib), 256 * mib, Some(256 * mib)).is_ok());
        assert!(budget(None, 256 * mib + 1, Some(256 * mib)).is_err());
        assert!(budget(Some(512 * mib), u64::MAX, None).is_ok());
    }
}
