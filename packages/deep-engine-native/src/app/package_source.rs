use crate::player_content::PlayerContent;
use std::path::PathBuf;

pub(super) fn load(path: PathBuf) -> Result<PlayerContent, String> {
    if path.is_dir() {
        return crate::asset_package_cli::load(&path.join("manifest.json"));
    }
    if path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| {
            name == "manifest.json" || (cfg!(windows) && name.eq_ignore_ascii_case("manifest.json"))
        })
    {
        // Runtime JSON may legitimately be called manifest.json. Do not infer its
        // schema from a filename when the existing Runtime validator accepts it.
        if deep_engine_native::runtime_package::load_and_validate_runtime_package(&path).is_err() {
            match crate::asset_package_cli::load(&path) {
                Ok(content) => return Ok(content),
                Err(asset_error) => {
                    return crate::runtime_package_startup::load_auto(&path)
                        .map(|p| p.into_content())
                        .map_err(|runtime_error| format!("{asset_error}; {runtime_error}"));
                }
            }
        }
    }
    crate::runtime_package_startup::load_auto(&path).map(|p| p.into_content())
}

#[derive(Default)]
pub(super) struct DropBatch {
    hovered: usize,
    dropped: Vec<PathBuf>,
    rejected_drag: bool,
}
impl DropBatch {
    pub fn hover(&mut self) {
        if self.rejected_drag {
            self.cancel();
        }
        self.hovered = (self.hovered + 1).min(2);
    }
    pub fn push(&mut self, path: PathBuf) {
        if !self.rejected_drag && self.dropped.len() < 2 {
            self.dropped.push(path);
        }
    }
    pub fn cancel(&mut self) {
        self.hovered = 0;
        self.dropped.clear();
        self.rejected_drag = false;
    }
    pub fn take(&mut self) -> Option<Result<PathBuf, &'static str>> {
        if self.dropped.is_empty() {
            return None;
        }
        let result = if self.hovered > 1 || self.dropped.len() != 1 {
            Err("drop exactly one Runtime Package or Asset Package directory")
        } else {
            Ok(self.dropped.remove(0))
        };
        self.cancel();
        self.rejected_drag = result.is_err();
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_sources_share_validators_without_publishing_recovery_records() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let directory = root.join("tests/fixtures/asset-directory-v1");
        let domain = load(directory.clone())
            .unwrap()
            .resource_domain()
            .to_owned();
        for path in [directory.clone(), directory.join("manifest.json")] {
            let content = load(path).unwrap();
            assert_eq!(content.resource_domain(), domain);
            assert!(content.pending_asset_lkg.is_some());
            assert!(content.pending_lkg.is_none());
        }
        #[cfg(windows)]
        assert_eq!(
            load(PathBuf::from(directory.to_str().unwrap().to_uppercase()))
                .unwrap()
                .resource_domain(),
            domain
        );
        #[cfg(windows)]
        assert_eq!(
            load(directory.join("MANIFEST.JSON"))
                .unwrap()
                .resource_domain(),
            domain
        );
        let runtime = root.join("tests/fixtures/runtime-package-v1.json");
        assert!(load(runtime.clone()).unwrap().pending_lkg.is_some());
        let temporary =
            std::env::temp_dir().join(format!("drop-runtime-name-{}", std::process::id()));
        std::fs::create_dir_all(&temporary).unwrap();
        let named = temporary.join("manifest.json");
        std::fs::copy(runtime, &named).unwrap();
        assert!(load(named).unwrap().pending_lkg.is_some());
        std::fs::remove_dir_all(temporary).unwrap();
        assert!(load(root.join("tests/fixtures")).is_err());
    }
    #[test]
    fn drop_batches_reject_multiple_paths_and_cancel_without_opening() {
        let mut b = DropBatch::default();
        b.hover();
        b.push("one".into());
        assert_eq!(b.take().unwrap().unwrap(), PathBuf::from("one"));
        b.push("one".into());
        b.push("two".into());
        assert!(b.take().unwrap().is_err());
        b.push("late path from rejected drag".into());
        assert!(b.take().is_none());
        b.hover();
        b.hover();
        b.push("one".into());
        assert!(b.take().unwrap().is_err());
        b.push("cancelled".into());
        b.cancel();
        assert!(b.take().is_none());
    }
}
