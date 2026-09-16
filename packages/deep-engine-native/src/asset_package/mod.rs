//! Deep Asset Package v1 manifest validation, distinct from Runtime Package execution.
pub mod directory;
mod names;
pub mod recovery;
mod types;
mod validation;
pub use types::*;

pub struct ValidatedAssetPackage {
    pub package: AssetPackage,
    pub resource_order: Vec<String>,
}
pub fn parse(bytes: &[u8]) -> Result<ValidatedAssetPackage, String> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("asset-package/input-budget".into());
    }
    let value =
        crate::runtime_package::parse_bounded_json(bytes).map_err(|error| error.to_string())?;
    fn budget(value: &serde_json::Value, nodes: &mut usize) -> Result<(), String> {
        *nodes += 1;
        if *nodes > 500_000 {
            return Err("asset-package/node-budget".into());
        }
        match value {
            serde_json::Value::String(text) if text.encode_utf16().count() > 8192 => {
                return Err("asset-package/string-budget".into());
            }
            serde_json::Value::Number(number)
                if number
                    .as_f64()
                    .is_some_and(|n| n == 0. && n.is_sign_negative()) =>
            {
                return Err("asset-package/non-canonical-number".into());
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    budget(value, nodes)?;
                }
            }
            serde_json::Value::Object(values) => {
                for value in values.values() {
                    budget(value, nodes)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    budget(&value, &mut 0)?;
    let package: AssetPackage =
        serde_json::from_value(value).map_err(|error| format!("asset-package/schema: {error}"))?;
    let resource_order = validation::validate(&package)?;
    Ok(ValidatedAssetPackage {
        package,
        resource_order,
    })
}
