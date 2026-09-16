use super::{names::*, *};
use std::collections::{BTreeMap, BTreeSet};
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const FACETS: &[&str] = &[
    "geometry",
    "hierarchy",
    "materials",
    "textures",
    "animation",
    "skin",
    "morph",
    "cameras",
    "lights",
    "colliders",
    "navmesh",
    "metadata",
    "pmi",
    "behavior",
    "audio",
];
fn require(valid: bool, reason: &str) -> Result<(), String> {
    if valid {
        Ok(())
    } else {
        Err(format!("asset-package/{reason}"))
    }
}
fn sorted<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut previous = None;
    for value in values {
        if previous.is_some_and(|old| old >= value) {
            return false;
        }
        previous = Some(value);
    }
    true
}
pub(super) fn validate(package: &AssetPackage) -> Result<Vec<String>, String> {
    let m = &package.manifest;
    require(
        package.schema_version == 1 && m.schema_version == 1,
        "version",
    )?;
    require(id(&m.package_id) && id(&m.entry_scene), "identity")?;
    require(
        logical(&m.source.logical_name)
            && hash(&m.source.content_hash)
            && m.source.byte_length <= SAFE_INTEGER,
        "source",
    )?;
    let importer = &m.importer;
    require(
        id(&importer.id)
            && token(&importer.version, 128, ".+_-", false)
            && hash(&importer.recipe_hash)
            && importer.deterministic,
        "importer",
    )?;
    compatibility(m)?;
    require(
        package.blobs.len() <= 65_536 && m.resources.len() <= 65_536,
        "resource-budget",
    )?;
    require(
        sorted(package.blobs.iter().map(|blob| blob.hash.as_str())),
        "blob-order",
    )?;
    let mut blobs = BTreeSet::new();
    for blob in &package.blobs {
        let media: Vec<_> = blob.media_type.split('/').collect();
        require(
            hash(&blob.hash)
                && blob.byte_length <= SAFE_INTEGER
                && media.len() == 2
                && token(media[0], 64, ".+-", true)
                && token(media[1], 128, ".+-", true),
            "blob",
        )?;
        blobs.insert(blob.hash.as_str());
    }
    require(
        sorted(m.resources.iter().map(|resource| resource.id.as_str())),
        "resource-order",
    )?;
    let resources: BTreeMap<_, _> = m
        .resources
        .iter()
        .map(|resource| (resource.id.as_str(), resource))
        .collect();
    let mut paths = BTreeSet::new();
    for resource in &m.resources {
        require(
            id(&resource.id)
                && logical(&resource.logical_path)
                && paths.insert(&resource.logical_path),
            "resource-path-identity",
        )?;
        require(
            [
                "scene",
                "mesh",
                "material",
                "texture",
                "animation",
                "skin",
                "morph",
                "metadata",
                "pmi",
                "behavior",
                "audio",
                "other",
            ]
            .contains(&resource.kind.as_str()),
            "resource-kind",
        )?;
        require(
            hash(&resource.blob_hash) && blobs.contains(resource.blob_hash.as_str()),
            "missing-blob",
        )?;
        require(
            resource.dependencies.len() <= 4096
                && sorted(resource.dependencies.iter().map(String::as_str)),
            "dependency-order-budget",
        )?;
        require(
            resource
                .dependencies
                .iter()
                .all(|dep| id(dep) && resources.contains_key(dep.as_str())),
            "missing-dependency",
        )?;
    }
    require(
        resources
            .get(m.entry_scene.as_str())
            .is_some_and(|resource| resource.kind == "scene"),
        "entry-scene",
    )?;
    // Iterative DFS matches the TS sorted traversal without risking native stack overflow.
    let mut state = BTreeMap::new();
    let mut order = Vec::new();
    for &root in resources.keys() {
        let mut stack = vec![(root, false)];
        while let Some((node, finish)) = stack.pop() {
            if finish {
                state.insert(node, 2);
                order.push(node.to_owned());
                continue;
            }
            match state.get(node) {
                Some(2) => continue,
                Some(1) => return Err("asset-package/dependency-cycle".into()),
                _ => {}
            }
            state.insert(node, 1);
            stack.push((node, true));
            for dependency in resources[node].dependencies.iter().rev() {
                stack.push((dependency.as_str(), false));
            }
        }
    }
    Ok(order)
}

fn compatibility(m: &Manifest) -> Result<(), String> {
    let c = &m.compatibility;
    require(
        c.schema_version == 1
            && token(&c.id, 256, "._:/-", false)
            && token(&c.format, 32, "._+-", true)
            && hash(&c.fixture_set_hash)
            && !c.importer_version.trim().is_empty()
            && c.importer_version.encode_utf16().count() <= 128
            && c.deterministic
            && c.runtime_artifact == "deep-asset-package",
        "compatibility",
    )?;
    require(
        [
            "model-file",
            "unity-project",
            "unity-asset-package",
            "unity-upm-package",
            "unity-asset-bundle",
            "unity-addressables",
        ]
        .contains(&c.source_kind.as_str()),
        "source-kind",
    )?;
    require(
        [
            "direct-parser",
            "open-converter",
            "licensed-converter",
            "unity-editor-exporter",
        ]
        .contains(&c.importer.as_str()),
        "importer-kind",
    )?;
    require(
        c.source_kind == m.source.kind
            && c.importer == m.importer.kind
            && c.importer_version == m.importer.version
            && (c.source_kind == "model-file" || c.importer == "unity-editor-exporter"),
        "provenance-mismatch",
    )?;
    require(
        c.facets.len() == FACETS.len() && FACETS.iter().all(|key| c.facets.contains_key(*key)),
        "facets",
    )?;
    for evidence in c.facets.values() {
        require(
            ["verified", "partial", "unsupported", "unverified"]
                .contains(&evidence.status.as_str())
                && sorted(evidence.evidence_ids.iter().map(String::as_str))
                && evidence
                    .evidence_ids
                    .iter()
                    .all(|id| token(id, 256, "._:/-", false)),
            "evidence",
        )?;
        require(
            evidence.reason.as_ref().is_none_or(|reason| {
                !reason.trim().is_empty() && reason.encode_utf16().count() <= 1024
            }) && (evidence.status != "verified" || !evidence.evidence_ids.is_empty())
                && (!matches!(evidence.status.as_str(), "partial" | "unsupported")
                    || evidence.reason.is_some()),
            "evidence-reason",
        )?;
    }
    Ok(())
}
