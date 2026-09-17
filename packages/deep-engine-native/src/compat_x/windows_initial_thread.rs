use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::Child,
};
use windows_sys::Win32::System::{
    Diagnostics::ProcessSnapshotting::*,
    Threading::{GetCurrentProcess, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
};

struct Snapshot(HPSS);
impl Drop for Snapshot {
    fn drop(&mut self) {
        unsafe {
            PssFreeSnapshot(GetCurrentProcess(), self.0);
        }
    }
}
struct Marker(HPSSWALK);
impl Drop for Marker {
    fn drop(&mut self) {
        unsafe {
            PssWalkMarkerFree(self.0);
        }
    }
}
fn checked(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

pub(super) fn resume_initial_thread(child: &Child) -> io::Result<()> {
    // 只抓取目标进程的一条初始线程。全系统ToolHelp快照在并发启动时实测近900ms。
    let mut snapshot = std::ptr::null_mut();
    checked(unsafe {
        PssCaptureSnapshot(child.as_raw_handle(), PSS_CAPTURE_THREADS, 0, &mut snapshot)
    })?;
    let snapshot = Snapshot(snapshot);
    let mut marker = std::ptr::null_mut();
    checked(unsafe { PssWalkMarkerCreate(std::ptr::null(), &mut marker) })?;
    let marker = Marker(marker);
    let mut entry = PSS_THREAD_ENTRY::default();
    checked(unsafe {
        PssWalkSnapshot(
            snapshot.0,
            PSS_WALK_THREADS,
            marker.0,
            &mut entry as *mut _ as *mut _,
            size_of::<PSS_THREAD_ENTRY>() as u32,
        )
    })?;
    if entry.ProcessId != child.id() {
        return Err(io::Error::other("worker snapshot thread identity mismatch"));
    }
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.ThreadId) };
    if thread.is_null() {
        return Err(io::Error::last_os_error());
    }
    let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
    let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
    if previous == 1 {
        Ok(())
    } else {
        Err(io::Error::other(
            "worker initial thread was not suspended exactly once",
        ))
    }
}
