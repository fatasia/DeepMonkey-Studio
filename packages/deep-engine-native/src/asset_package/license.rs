use super::*;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LicenseEvidence {
    schema_version: u32,
    package_id: String,
    source_hash: String,
    resource_ids: Vec<String>,
    license_id: String,
    license_text_hash: String,
}
pub(super) fn validate(
    package: &AssetPackage,
    chunks: &BTreeMap<&str, Vec<u8>>,
) -> Result<(), String> {
    let mut covered = false;
    for resource in &package.manifest.resources {
        let blob = package
            .blobs
            .iter()
            .find(|blob| blob.hash == resource.blob_hash)
            .ok_or("asset-directory/license-blob")?;
        if blob.media_type != "application/vnd.deep.asset-license+json" {
            continue;
        }
        if resource.kind != "metadata" {
            return Err("asset-directory/license-kind".into());
        }
        let bytes = &chunks[resource.blob_hash.as_str()];
        if bytes.len() > 64 * 1024 {
            return Err("asset-directory/license-budget".into());
        }
        let value = crate::runtime_package::parse_bounded_json(bytes).map_err(|e| e.to_string())?;
        let evidence: LicenseEvidence =
            serde_json::from_value(value).map_err(|_| "asset-directory/license-schema")?;
        let text_resource = package.manifest.resources.iter().find(|r| {
            r.blob_hash == evidence.license_text_hash && resource.dependencies.contains(&r.id)
        });
        if evidence.schema_version != 1
            || evidence.package_id != package.manifest.package_id
            || evidence.source_hash != package.manifest.source.content_hash
            || evidence.license_id.trim().is_empty()
            || evidence.license_id.len() > 256
            || text_resource.is_none()
            || !chunks.contains_key(evidence.license_text_hash.as_str())
            || evidence.resource_ids.is_empty()
            || !evidence
                .resource_ids
                .windows(2)
                .all(|pair| pair[0] < pair[1])
            || evidence
                .resource_ids
                .iter()
                .any(|id| !package.manifest.resources.iter().any(|r| &r.id == id))
        {
            return Err("asset-directory/license-evidence".into());
        }
        let license_text = &chunks[evidence.license_text_hash.as_str()];
        if license_text.is_empty()
            || license_text.len() > 1024 * 1024
            || std::str::from_utf8(license_text).is_err()
        {
            return Err("asset-directory/license-text".into());
        }
        covered |= evidence
            .resource_ids
            .contains(&package.manifest.entry_scene);
    }
    if !covered {
        return Err("asset-directory/missing-scene-license-evidence".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn license_evidence_must_bind_source_scene_and_real_text_dependency() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/asset-directory-v1");
        let checked = parse(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
        let package = checked.package;
        let mut chunks: BTreeMap<_, _> = package
            .blobs
            .iter()
            .map(|blob| {
                (
                    blob.hash.as_str(),
                    fs::read(root.join("blobs").join(&blob.hash)).unwrap(),
                )
            })
            .collect();
        let hash = package
            .blobs
            .iter()
            .find(|blob| blob.media_type == "application/vnd.deep.asset-license+json")
            .unwrap()
            .hash
            .as_str();
        let proof: serde_json::Value = serde_json::from_slice(&chunks[hash]).unwrap();
        validate(&package, &chunks).unwrap();
        for (key, value) in [
            ("sourceHash", serde_json::json!("0".repeat(64))),
            ("packageId", serde_json::json!("different")),
            ("resourceIds", serde_json::json!(["missing"])),
            ("licenseTextHash", serde_json::json!("0".repeat(64))),
            ("licenseId", serde_json::json!("")),
        ] {
            let mut bad = proof.clone();
            bad[key] = value;
            chunks.insert(hash, serde_json::to_vec(&bad).unwrap());
            assert!(validate(&package, &chunks).is_err(), "{key}");
        }
    }
}
