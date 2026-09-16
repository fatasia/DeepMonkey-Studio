//! CPU-only text compilation for the trusted publication worker.
use deep_engine_native::platform_text::{TEXT_RASTER_REQUEST_MAX_BYTES, rasterize_text_json};
use std::{
    ffi::OsString,
    fs::OpenOptions,
    io::{Read, Write},
    path::PathBuf,
};

pub(crate) fn execute(
    command: Option<&str>,
    args: &mut impl Iterator<Item = OsString>,
) -> Option<Result<(), String>> {
    if command != Some("--rasterize-text") {
        return None;
    }
    Some((|| {
        let request = crate::player_cli::required_path(args, "--rasterize-text")?;
        if args.next().as_deref() != Some(std::ffi::OsStr::new("--output")) {
            return Err("expected --output after text request path".into());
        }
        let output = PathBuf::from(args.next().ok_or("text output path missing")?);
        crate::player_cli::reject_extra(args)?;
        let mut file = std::fs::File::open(&request).map_err(|e| e.to_string())?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("text request must be a regular file".into());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(TEXT_RASTER_REQUEST_MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let result = rasterize_text_json(&bytes)?;
        // A failed job cannot overwrite an earlier completed result.
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)
            .map_err(|e| e.to_string())?;
        target.write_all(&result).map_err(|e| e.to_string())?;
        target.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })())
}
