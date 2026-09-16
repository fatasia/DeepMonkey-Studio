use super::*;
pub(super) struct Staged<'a> {
    pub target: &'a Path,
    pub snapshot: &'a Snapshot,
    pub published: bool,
}
impl Drop for Staged<'_> {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        for (hash, _) in &self.snapshot.chunks {
            if !super::hash(hash) {
                continue;
            }
            let path = self.target.join("blobs").join(hash);
            if directory::safe_path(&path).is_ok() {
                let _ = fs::remove_file(path);
            }
        }
        let manifest = self.target.join("manifest.json");
        if directory::safe_path(&manifest).is_ok() {
            let _ = fs::remove_file(manifest);
        }
        let _ = fs::remove_dir(self.target.join("blobs"));
        let _ = fs::remove_dir(self.target);
    }
}
pub(super) fn retire(store: &Store, active: &str, previous: Option<&str>) {
    let Ok(entries) = fs::read_dir(&store.directory) else {
        return;
    };
    for entry in entries.take(128).flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !snapshot_name(&name) || name == active || previous == Some(name.as_str()) {
            continue;
        }
        let path = entry.path();
        let manifest = path.join("manifest.json");
        if manifest.to_string_lossy().to_lowercase() == store.source {
            continue;
        }
        let Ok(loaded) = directory::load(&manifest) else {
            continue;
        };
        if !name.starts_with(&loaded.manifest_hash)
            || store.index().is_err()
            || store.index().is_ok_and(|index| index.snapshot != active)
        {
            return;
        }
        // No recursive deletion: remove only revalidated digest files from this generated snapshot.
        for (hash, _) in &loaded.snapshot.chunks {
            let file = path.join("blobs").join(hash);
            if directory::safe_path(&file).is_ok() {
                let _ = fs::remove_file(file);
            }
        }
        if directory::safe_path(&manifest).is_ok() {
            let _ = fs::remove_file(manifest);
        }
        let _ = fs::remove_dir(path.join("blobs"));
        if let Err(error) = fs::remove_dir(path) {
            eprintln!("asset-lkg/retirement-deferred: {}", error.kind());
        }
    }
}
