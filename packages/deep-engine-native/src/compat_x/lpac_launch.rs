use super::profile::{Profile, wide};
#[path = "lpac_token.rs"]
mod token;
use std::{
    fs::File,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use token::verify_identity;
use windows_sys::Win32::{
    Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0},
    Security::*,
    System::{
        Pipes::CreatePipe, Threading::*,
        WindowsProgramming::PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT,
    },
};

struct Attributes(Vec<usize>);
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 4, 0, &mut bytes);
        }
        let mut value = vec![0; bytes.div_ceil(size_of::<usize>())];
        if unsafe { InitializeProcThreadAttributeList(value.as_mut_ptr().cast(), 4, 0, &mut bytes) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(value))
    }
    fn add<T>(&mut self, key: u32, value: &T) -> io::Result<()> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.0.as_mut_ptr().cast(),
                0,
                key as usize,
                value as *const T as *const _,
                size_of::<T>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast());
        }
    }
}
fn pipe(parent_reads: bool) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedHandle::from_raw_handle(read) };
    let write = unsafe { OwnedHandle::from_raw_handle(write) };
    let pair = if parent_reads {
        (read, write)
    } else {
        (write, read)
    };
    if unsafe { SetHandleInformation(pair.0.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pair)
}

pub(super) struct NativeChild {
    process: OwnedHandle,
    thread: OwnedHandle,
}
impl NativeChild {
    pub fn process_id(&self) -> u32 {
        unsafe { GetProcessId(self.process.as_raw_handle()) }
    }
    pub fn exited(&self) -> io::Result<Option<bool>> {
        let status = unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) };
        if status == WAIT_OBJECT_0 {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if code != 0 {
                return Err(io::Error::other(format!(
                    "LPAC worker exit status {code:#x}"
                )));
            }
            Ok(Some(true))
        } else if status == windows_sys::Win32::Foundation::WAIT_TIMEOUT {
            Ok(None)
        } else {
            Err(io::Error::last_os_error())
        }
    }
}
impl Drop for NativeChild {
    fn drop(&mut self) {
        unsafe {
            TerminateProcess(self.process.as_raw_handle(), 1);
            WaitForSingleObject(self.process.as_raw_handle(), 250);
        }
    }
}

pub(super) fn launch(profile: &Profile, job: HANDLE) -> io::Result<(NativeChild, File, File)> {
    let (input, child_input) = pipe(false)?;
    let (output, child_output) = pipe(true)?;
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid,
        ..Default::default()
    };
    let lpac = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    let handles = [child_input.as_raw_handle(), child_output.as_raw_handle()];
    let jobs = [job];
    let mut attributes = Attributes::new()?;
    attributes
        .add(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities)
        .map_err(|e| io::Error::other(format!("security capabilities: {e}")))?;
    attributes
        .add(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &lpac)
        .map_err(|e| io::Error::other(format!("LPAC opt-out: {e}")))?;
    attributes
        .add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)
        .map_err(|e| io::Error::other(format!("handle list: {e}")))?;
    attributes
        .add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)
        .map_err(|e| io::Error::other(format!("job list: {e}")))?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_input.as_raw_handle();
    startup.StartupInfo.hStdOutput = child_output.as_raw_handle();
    startup.StartupInfo.hStdError = child_output.as_raw_handle();
    startup.lpAttributeList = attributes.0.as_mut_ptr().cast();
    let mut info = PROCESS_INFORMATION::default();
    let mut command = std::ffi::OsString::from("\"");
    command.push(&profile.executable);
    command.push("\"");
    let mut command = wide(command);
    let mut environment = Vec::new();
    for key in ["APPDATA", "LOCALAPPDATA", "SystemRoot", "USERPROFILE"] {
        let value =
            std::env::var_os(key).ok_or_else(|| io::Error::other(format!("{key} unavailable")))?;
        let mut variable = std::ffi::OsString::from(format!("{key}="));
        variable.push(value);
        environment.extend(wide(variable));
    }
    environment.push(0);
    if unsafe {
        CreateProcessW(
            wide(&profile.executable).as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            wide(&profile.directory).as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    } == 0
    {
        return Err(io::Error::other(format!(
            "CreateProcessW: {}",
            io::Error::last_os_error()
        )));
    }
    let child = NativeChild {
        process: unsafe { OwnedHandle::from_raw_handle(info.hProcess) },
        thread: unsafe { OwnedHandle::from_raw_handle(info.hThread) },
    };
    verify_identity(child.process.as_raw_handle(), profile.sid)
        .map_err(|e| io::Error::other(format!("token verification: {e}")))?;
    if unsafe { ResumeThread(child.thread.as_raw_handle()) } != 1 {
        return Err(io::Error::other("LPAC initial thread resume failed"));
    }
    Ok((child, File::from(input), File::from(output)))
}
