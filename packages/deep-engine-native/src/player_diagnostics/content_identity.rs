//! Identity fields shared by all native Player diagnostic reports.

use crate::player_content::PlayerContent;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub(super) struct ContentIdentity {
    kind: &'static str,
    scene_content_key: String,
    scene_content_key_algorithm: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_package_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_package_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_package_sha256: Option<String>,
}

impl ContentIdentity {
    pub(super) fn from_content(content: &PlayerContent) -> Self {
        let package = content.runtime_package();
        Self {
            kind: if package.is_some() {
                "runtime-package"
            } else {
                "render-packet"
            },
            scene_content_key: format!("{:016x}", content.scene_content_key()),
            scene_content_key_algorithm: "native-scene-key-v1",
            runtime_package_id: package.map(|value| value.package_id.clone()),
            runtime_package_version: package.map(|value| value.package_version.clone()),
            runtime_package_sha256: package.map(|value| value.package_hash.clone()),
        }
    }
}
