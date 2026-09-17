use deep_engine_native::runtime_package::{
    LoadedXRuntimePackage, parse_and_validate_x_runtime_package, read_runtime_package_bytes,
};
use std::path::Path;

pub struct Source {
    pub loaded: LoadedXRuntimePackage,
    pub bytes: Vec<u8>,
    pub active: &'static str,
    pub primary_rejection: Option<String>,
}

pub fn load(
    path: &Path,
    store: &Result<crate::runtime_lkg::Store, String>,
) -> Result<Source, String> {
    let primary = read_runtime_package_bytes(path)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            let loaded = parse_and_validate_x_runtime_package(&bytes)
                .map_err(|error| format!("X runtime package preflight failed: {error}"))?;
            Ok((loaded, bytes))
        });
    match primary {
        Ok((loaded, bytes)) => Ok(Source {
            loaded,
            bytes,
            active: "primary",
            primary_rejection: None,
        }),
        Err(primary_error) => {
            let bytes = store
                .as_ref()
                .map_err(|reason| format!("primary rejected: {primary_error}; {reason}"))?
                .restore_x()
                .map_err(|reason| format!("primary rejected: {primary_error}; {reason}"))?;
            let loaded = parse_and_validate_x_runtime_package(&bytes)
                .map_err(|error| format!("X LKG package invalid: {error}"))?;
            Ok(Source {
                loaded,
                bytes,
                active: "last-known-good",
                primary_rejection: Some(primary_error),
            })
        }
    }
}
