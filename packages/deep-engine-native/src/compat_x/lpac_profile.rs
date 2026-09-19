use std::{
    io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        },
        FreeSid,
        Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile},
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PSID,
    },
};

pub(super) fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
pub(super) struct Profile {
    name: Vec<u16>,
    pub sid: PSID,
    pub directory: PathBuf,
    pub executable: PathBuf,
    cleaned: bool,
    profile_removed: bool,
}
impl Profile {
    pub fn new(worker: &Path) -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let identity = format!(
            "DeepMonkey.X.{}.{}.{}",
            std::process::id(),
            nonce,
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let directory = std::env::temp_dir().join(&identity);
        std::fs::create_dir(&directory)?;
        let name = wide(&identity);
        let mut sid = std::ptr::null_mut();
        let hr = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                std::ptr::null(),
                0,
                &mut sid,
            )
        };
        if hr < 0 {
            std::fs::remove_dir(&directory)?;
            return Err(io::Error::other(format!(
                "CreateAppContainerProfile: {hr:#x}"
            )));
        }
        let mut profile = Self {
            name,
            sid,
            executable: directory.join("worker.exe"),
            directory,
            cleaned: false,
            profile_removed: false,
        };
        let setup = (|| {
            std::fs::copy(worker, &profile.executable)?;
            profile.grant_rx(&profile.directory)?;
            profile.grant_rx(&profile.executable)
        })();
        if let Err(error) = setup {
            return Err(profile.cleanup_after_error(error));
        }
        Ok(profile)
    }
    pub fn cleanup_after_error(&mut self, error: io::Error) -> io::Error {
        match self.cleanup() {
            Ok(()) => error,
            Err(cleanup) => io::Error::other(format!("{error}; LPAC cleanup failed: {cleanup}")),
        }
    }
    fn grant_rx(&self, path: &Path) -> io::Result<()> {
        let mut text = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(self.sid, &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut len = 0;
        while unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        unsafe {
            LocalFree(text.cast());
        }
        // 仅全新专用目录：owner/system完全访问，精确新SID只读执行，无全局应用包授权。
        let sddl = wide(format!(
            "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)(A;OICI;GRGX;;;{sid})"
        ));
        let mut descriptor = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let result =
            unsafe { SetFileSecurityW(wide(path).as_ptr(), DACL_SECURITY_INFORMATION, descriptor) };
        let error = io::Error::last_os_error();
        unsafe {
            LocalFree(descriptor);
        }
        if result == 0 {
            Err(error)
        } else {
            Ok(())
        }
    }
    pub fn cleanup(&mut self) -> io::Result<()> {
        if self.cleaned {
            return Ok(());
        }
        if !self.profile_removed {
            let hr = unsafe { DeleteAppContainerProfile(self.name.as_ptr()) };
            if hr < 0 {
                return Err(io::Error::other(format!(
                    "DeleteAppContainerProfile: {hr:#x}"
                )));
            }
            self.profile_removed = true;
        }
        // 此目录由本实例create_dir独占创建，worker仅RX且不能创建reparse point。
        std::fs::remove_dir_all(&self.directory)?;
        self.cleaned = true;
        Ok(())
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = self.cleanup();
        unsafe {
            FreeSid(self.sid);
        }
    }
}
