use std::{
    fs::{File, Metadata},
    path::Path,
};

use super::{super::RuntimePackageError, io_failure};

#[cfg(unix)]
pub(super) type FileIdentity = (u64, u64);
#[cfg(windows)]
pub(super) type FileIdentity = (u32, u64);
#[cfg(not(any(unix, windows)))]
pub(super) type FileIdentity = ();

#[cfg(unix)]
pub(super) fn path_file_identity(
    _path: &Path,
    metadata: &Metadata,
) -> Result<Option<FileIdentity>, RuntimePackageError> {
    use std::os::unix::fs::MetadataExt;
    Ok(Some((metadata.dev(), metadata.ino())))
}

#[cfg(unix)]
pub(super) fn opened_file_identity(
    _file: &File,
    metadata: &Metadata,
) -> Result<Option<FileIdentity>, RuntimePackageError> {
    path_file_identity(Path::new(""), metadata)
}

#[cfg(windows)]
pub(super) fn path_file_identity(
    path: &Path,
    metadata: &Metadata,
) -> Result<Option<FileIdentity>, RuntimePackageError> {
    let file = File::open(path).map_err(|error| io_failure("identity-open-failed", &error))?;
    opened_file_identity(&file, metadata)
}

#[cfg(windows)]
pub(super) fn opened_file_identity(
    file: &File,
    _metadata: &Metadata,
) -> Result<Option<FileIdentity>, RuntimePackageError> {
    use std::{ffi::c_void, mem::MaybeUninit, os::windows::io::AsRawHandle};

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct FileInformation {
        attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "GetFileInformationByHandle"]
        fn get_file_information_by_handle(
            file: *mut c_void,
            information: *mut FileInformation,
        ) -> i32;
    }

    let mut information = MaybeUninit::<FileInformation>::uninit();
    // SAFETY: `file` owns the live raw handle and the output has the exact ABI layout.
    let succeeded =
        unsafe { get_file_information_by_handle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(io_failure(
            "identity-failed",
            &std::io::Error::last_os_error(),
        ));
    }
    // SAFETY: a successful call initializes every field in FileInformation.
    let information = unsafe { information.assume_init() };
    let file_index =
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low);
    Ok(Some((information.volume_serial_number, file_index)))
}

#[cfg(not(any(unix, windows)))]
pub(super) fn path_file_identity(
    _path: &Path,
    _metadata: &Metadata,
) -> Result<Option<FileIdentity>, RuntimePackageError> {
    Ok(None)
}

#[cfg(not(any(unix, windows)))]
pub(super) fn opened_file_identity(
    _file: &File,
    _metadata: &Metadata,
) -> Result<Option<FileIdentity>, RuntimePackageError> {
    Ok(None)
}
