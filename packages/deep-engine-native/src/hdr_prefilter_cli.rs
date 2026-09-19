use std::{
    ffi::{OsStr, OsString},
    fs::OpenOptions,
    io::{Read, Write},
    path::PathBuf,
};
pub(crate) fn execute(
    command: Option<&str>,
    args: &mut impl Iterator<Item = OsString>,
) -> Option<Result<(), String>> {
    if command != Some("--prefilter-hdr") {
        return None;
    }
    Some((|| {
        let request = crate::player_cli::required_path(args, "--prefilter-hdr")?;
        if args.next().as_deref() != Some(OsStr::new("--output")) {
            return Err("HDR output path required".into());
        }
        let output = PathBuf::from(args.next().ok_or("HDR output path missing")?);
        crate::player_cli::reject_extra(args)?;
        let file = std::fs::File::open(request).map_err(|e| e.to_string())?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("HDR input must be a regular file".into());
        }
        let mut bytes = Vec::new();
        file.take(deep_engine_native::ibl::panorama_wire::MAX_REQUEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let result = deep_engine_native::ibl::panorama_wire::prefilter_json(&bytes)?;
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)
            .map_err(|e| e.to_string())?;
        target
            .write_all(&result)
            .and_then(|_| target.sync_all())
            .map_err(|e| e.to_string())
    })())
}
