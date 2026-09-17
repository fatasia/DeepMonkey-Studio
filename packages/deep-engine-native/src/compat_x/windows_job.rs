//! 挂起启动后先绑定 Job 再恢复线程，避免首条用户指令之前的进程逃逸窗口。
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::Child,
};
use windows_sys::Win32::System::JobObjects::*;

/// OS committed-memory/累计user CPU限制，与XBudget的逻辑内存/work units独立。
#[derive(Debug, Clone, Copy)]
pub struct XProcessLimits {
    pub process_commit_bytes: usize,
    pub job_commit_bytes: usize,
    pub active_processes: u32,
    pub job_cpu_time_ms: u64,
}

impl Default for XProcessLimits {
    fn default() -> Self {
        Self {
            process_commit_bytes: 128 * 1024 * 1024,
            job_commit_bytes: 256 * 1024 * 1024,
            active_processes: 8,
            job_cpu_time_ms: 2_000,
        }
    }
}

impl XProcessLimits {
    pub fn validate(self) -> io::Result<()> {
        if self.process_commit_bytes < 16 * 1024 * 1024
            || self.process_commit_bytes > 512 * 1024 * 1024
            || self.job_commit_bytes < self.process_commit_bytes
            || self.job_commit_bytes > 1024 * 1024 * 1024
            || self.active_processes == 0
            || self.active_processes > 8
            || self.job_cpu_time_ms == 0
            || self.job_cpu_time_ms > 60_000
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid X process limits",
            ));
        }
        Ok(())
    }
}

pub(super) struct ProcessJob(OwnedHandle, i64);
impl ProcessJob {
    pub(super) fn raw_handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.0.as_raw_handle()
    }
    pub(super) fn cpu_budget_exceeded(&self) -> io::Result<bool> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(info.TotalUserTime > self.1)
    }
    pub(super) fn terminate_and_wait(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let started = std::time::Instant::now();
        loop {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if info.ActiveProcesses == 0 {
                return Ok(());
            }
            if started.elapsed() > std::time::Duration::from_millis(250) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "X worker process tree cleanup timed out",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    pub(super) fn new(limits: XProcessLimits) -> io::Result<Self> {
        limits.validate()?;
        // NULL security attributes: Job句柄不继承；匿名Job无法由worker按名字打开。
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(
            unsafe { OwnedHandle::from_raw_handle(handle) },
            (limits.job_cpu_time_ms * 10_000) as i64,
        );
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_JOB_TIME;
        info.BasicLimitInformation.ActiveProcessLimit = limits.active_processes;
        info.BasicLimitInformation.PerJobUserTimeLimit = (limits.job_cpu_time_ms * 10_000) as i64;
        info.ProcessMemoryLimit = limits.process_commit_bytes;
        info.JobMemoryLimit = limits.job_commit_bytes;
        let ok = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub(super) fn assign_and_resume(&self, child: &Child) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        initial_thread::resume_initial_thread(child)
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        // 主worker已退出时也终止仍持有stdio的孙进程；close另有kill-on-close兜底。
        unsafe {
            TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

#[path = "windows_initial_thread.rs"]
mod initial_thread;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_limits_rejected_before_creating_job() {
        for limits in [
            XProcessLimits {
                active_processes: 0,
                ..Default::default()
            },
            XProcessLimits {
                job_cpu_time_ms: u64::MAX,
                ..Default::default()
            },
            XProcessLimits {
                process_commit_bytes: 1,
                ..Default::default()
            },
            XProcessLimits {
                job_commit_bytes: 1,
                ..Default::default()
            },
        ] {
            assert!(ProcessJob::new(limits).is_err());
        }
    }
    #[test]
    fn kernel_reports_exact_limits_without_breakaway() {
        let limits = XProcessLimits::default();
        let job = ProcessJob::new(limits).unwrap();
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        assert_ne!(
            unsafe {
                QueryInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(info.ProcessMemoryLimit, limits.process_commit_bytes);
        assert_eq!(info.JobMemoryLimit, limits.job_commit_bytes);
        assert_eq!(
            info.BasicLimitInformation.ActiveProcessLimit,
            limits.active_processes
        );
        assert_eq!(
            info.BasicLimitInformation.PerJobUserTimeLimit,
            (limits.job_cpu_time_ms * 10_000) as i64
        );
        assert_ne!(
            info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            0
        );
        assert_eq!(
            info.BasicLimitInformation.LimitFlags
                & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK),
            0
        );
    }
}
