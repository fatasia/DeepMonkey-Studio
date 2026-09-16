use std::{
    fs::{self, File, Metadata},
    io::{self, Read},
    path::Path,
    time::SystemTime,
};

use super::{RuntimePackageError, fail, validate};

mod file_identity;
#[cfg(test)]
mod tests;

use file_identity::{FileIdentity, opened_file_identity, path_file_identity};

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileSnapshot {
    identity: Option<FileIdentity>,
    len: u64,
    modified: Option<SystemTime>,
}

pub(super) fn read(path: &Path) -> Result<Vec<u8>, RuntimePackageError> {
    read_with_hook(path, || {})
}

fn read_with_hook(path: &Path, after_open: impl FnOnce()) -> Result<Vec<u8>, RuntimePackageError> {
    let path_before = path_snapshot(path)?;
    let mut file = File::open(path).map_err(|error| io_failure("open-failed", &error))?;
    let opened_before = opened_snapshot(&file)?;
    ensure_unchanged(&path_before, &opened_before)?;
    ensure_limit(opened_before.len)?;

    after_open();
    let mut bytes = Vec::new();
    (&mut file)
        .take(validate::MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_failure("read-failed", &error))?;
    validate::input_size(&bytes)?;

    let opened_after = opened_snapshot(&file)?;
    ensure_unchanged(&opened_before, &opened_after)?;
    let path_after = path_snapshot(path)?;
    ensure_unchanged(&opened_after, &path_after)?;
    Ok(bytes)
}

fn path_snapshot(path: &Path) -> Result<FileSnapshot, RuntimePackageError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| io_failure("metadata-failed", &error))?;
    if metadata.file_type().is_symlink() {
        return fail("runtime-package-read/symlink-rejected: symbolic links are not accepted");
    }
    ensure_regular(&metadata)?;
    let identity = path_file_identity(path, &metadata)?;
    snapshot_regular(&metadata, identity)
}

fn opened_snapshot(file: &File) -> Result<FileSnapshot, RuntimePackageError> {
    let metadata = file
        .metadata()
        .map_err(|error| io_failure("metadata-failed", &error))?;
    ensure_regular(&metadata)?;
    let identity = opened_file_identity(file, &metadata)?;
    snapshot_regular(&metadata, identity)
}

fn ensure_regular(metadata: &Metadata) -> Result<(), RuntimePackageError> {
    if !metadata.file_type().is_file() {
        return fail(
            "runtime-package-read/non-regular-file: cannot read runtime package from a non-regular file",
        );
    }
    Ok(())
}

fn snapshot_regular(
    metadata: &Metadata,
    identity: Option<FileIdentity>,
) -> Result<FileSnapshot, RuntimePackageError> {
    Ok(FileSnapshot {
        identity,
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn ensure_limit(len: u64) -> Result<(), RuntimePackageError> {
    if len > validate::MAX_INPUT_BYTES as u64 {
        return fail("Deep Runtime Package exceeds the 256 MiB input limit");
    }
    Ok(())
}

fn ensure_unchanged(
    before: &FileSnapshot,
    after: &FileSnapshot,
) -> Result<(), RuntimePackageError> {
    if before.identity != after.identity {
        return fail(
            "runtime-package-read/input-identity-changed: runtime package file identity changed while reading",
        );
    }
    if before.len != after.len {
        return fail(
            "runtime-package-read/input-size-changed: runtime package size changed while reading",
        );
    }
    if before.modified != after.modified {
        return fail(
            "runtime-package-read/input-modified: runtime package modification time changed while reading",
        );
    }
    Ok(())
}

fn io_failure(code: &str, error: &io::Error) -> RuntimePackageError {
    RuntimePackageError(format!(
        "runtime-package-read/{code}: cannot read runtime package (kind={:?}, os={:?})",
        error.kind(),
        error.raw_os_error()
    ))
}
