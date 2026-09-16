use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AssetPackage {
    #[serde(deserialize_with = "integer")]
    pub schema_version: u32,
    pub manifest: Manifest,
    pub blobs: Vec<Blob>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Blob {
    pub hash: String,
    #[serde(deserialize_with = "integer")]
    pub byte_length: u64,
    pub media_type: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    #[serde(deserialize_with = "integer")]
    pub schema_version: u32,
    pub package_id: String,
    pub source: Source,
    pub importer: Importer,
    pub compatibility: Compatibility,
    pub resources: Vec<Resource>,
    pub entry_scene: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Source {
    pub kind: String,
    pub logical_name: String,
    pub content_hash: String,
    #[serde(deserialize_with = "integer")]
    pub byte_length: u64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Importer {
    pub kind: String,
    pub id: String,
    pub version: String,
    pub recipe_hash: String,
    pub deterministic: bool,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub kind: String,
    pub logical_path: String,
    pub blob_hash: String,
    pub dependencies: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Compatibility {
    #[serde(deserialize_with = "integer")]
    pub schema_version: u32,
    pub id: String,
    pub source_kind: String,
    pub format: String,
    pub importer: String,
    pub runtime_artifact: String,
    pub importer_version: String,
    pub fixture_set_hash: String,
    pub deterministic: bool,
    pub facets: BTreeMap<String, Evidence>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Evidence {
    pub status: String,
    pub evidence_ids: Vec<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub reason: Option<String>,
}
fn required_nullable<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

fn integer<'de, D: serde::Deserializer<'de>, T: TryFrom<u64>>(
    deserializer: D,
) -> Result<T, D::Error> {
    let number = f64::deserialize(deserializer)?;
    if !number.is_finite()
        || number.fract() != 0.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&number)
    {
        return Err(serde::de::Error::custom(
            "expected a nonnegative JS safe integer",
        ));
    }
    T::try_from(number as u64).map_err(|_| serde::de::Error::custom("integer exceeds field range"))
}
