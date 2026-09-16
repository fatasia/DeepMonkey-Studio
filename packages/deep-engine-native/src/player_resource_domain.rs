use super::PlayerContent;
use deep_engine_native::runtime_package::runtime_content_sha256;
use std::path::Path;

pub(super) fn memory(package_id: &str) -> String {
    runtime_content_sha256(&serde_json::json!(["runtime-memory", package_id]))
}

impl PlayerContent {
    pub fn resource_domain(&self) -> &str {
        &self.resource_domain
    }

    /// Uses the authorized source, never the recovery snapshot that supplied bytes.
    /// Keep the same absolute/lowercase path binding as Runtime and Asset LKG.
    pub fn bind_resource_source(&mut self, path: &Path, kind: &str) -> Result<(), String> {
        self.bind_owned_resource_source(path, kind, None)
    }

    pub fn bind_owned_resource_source(
        &mut self,
        path: &Path,
        kind: &str,
        owner: Option<&str>,
    ) -> Result<(), String> {
        let absolute = std::path::absolute(path).map_err(|_| "resource-domain/source-path")?;
        let source = absolute
            .to_str()
            .ok_or("resource-domain/source-unicode")?
            .to_lowercase();
        self.resource_domain = runtime_content_sha256(&serde_json::json!([
            kind,
            source,
            owner,
            self.runtime_package().map(|p| p.package_id.as_str())
        ]));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn content() -> PlayerContent {
        PlayerContent::from_package(
            deep_engine_native::runtime_package::parse_and_validate_runtime_package(
                include_bytes!("../tests/fixtures/runtime-package-prefiltered-ibl-v1.json"),
            )
            .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn source_identity_is_stable_across_hash_revisions_and_windows_aliases() {
        let path = std::env::temp_dir().join("Deep-Source-Domain/scene.runtime.json");
        let mut a = content();
        let mut b = content();
        a.bind_resource_source(&path, "runtime-file").unwrap();
        b.runtime_package.as_mut().unwrap().package_hash = "f".repeat(64);
        b.bind_resource_source(&path, "runtime-file").unwrap();
        assert_eq!(a.resource_domain(), b.resource_domain());
        #[cfg(windows)]
        {
            let alias = path.to_str().unwrap().to_uppercase().replace('\\', "/");
            b.bind_resource_source(Path::new(&alias), "runtime-file")
                .unwrap();
            assert_eq!(a.resource_domain(), b.resource_domain());
        }
        b.runtime_package
            .as_mut()
            .unwrap()
            .package_id
            .push_str(".other");
        b.bind_resource_source(&path, "runtime-file").unwrap();
        assert_ne!(a.resource_domain(), b.resource_domain());
    }
}
