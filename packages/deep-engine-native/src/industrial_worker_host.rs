//! 工业 Node reader 的有界 stdio 宿主；Job 治理直接复用既有 X 实现。
use crate::compat_x::process::windows_job::{ProcessJob, XProcessLimits};
use serde::Deserialize;
use std::{
    io::{self, BufRead, Read, Write},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    parent_pid: u32,
    executable: String,
    arguments: Vec<String>,
    payload: serde_json::Value,
    max_memory_mb: usize,
    timeout_ms: u64,
    max_cpu_percent: u32,
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn run() -> io::Result<()> {
    let mut bytes = Vec::new();
    let mut host_input = io::BufReader::new(io::stdin());
    (&mut host_input)
        .take(32_769)
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() > 32_768 {
        return Err(io::Error::other("host request exceeds 32 KiB"));
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    let (cancel_sender, cancelled) = mpsc::channel();
    thread::spawn(move || {
        let mut byte = [0u8];
        let _ = host_input.read(&mut byte);
        let _ = cancel_sender.send(());
    });
    if !std::path::Path::new(&request.executable).is_absolute()
        || request.arguments.len() > 16
        || request.arguments.iter().any(|arg| arg.len() > 8192)
        || request.max_cpu_percent == 0
        || request.max_cpu_percent > 100
    {
        return Err(io::Error::other("invalid trusted worker command or budget"));
    }
    let parent = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, request.parent_pid) };
    if parent.is_null() {
        return Err(io::Error::last_os_error());
    }
    let parent = unsafe { OwnedHandle::from_raw_handle(parent) };
    let memory = request
        .max_memory_mb
        .checked_mul(1024 * 1024)
        .ok_or_else(|| io::Error::other("memory budget overflow"))?;
    let cpu_ms = request
        .timeout_ms
        .saturating_mul(u64::from(request.max_cpu_percent))
        / 100;
    let job = ProcessJob::new_for_conversion(XProcessLimits {
        process_commit_bytes: memory,
        job_commit_bytes: memory,
        active_processes: 4,
        job_cpu_time_ms: cpu_ms,
    })?;
    let mut command = Command::new(&request.executable);
    command
        .args(&request.arguments)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // 子进程拒绝原因(如 E57-rejected)必须可传导到调用方;转发线程在子进程终止后 join。
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    for name in ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = Running(command.spawn()?);
    job.assign_and_resume(&child.0)?;
    let stderr_pipe = child
        .0
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("worker stderr missing"))?;
    let stderr_forwarder = thread::spawn(move || {
        let mut stderr_pipe = stderr_pipe;
        let _ = io::copy(&mut stderr_pipe, &mut io::stderr());
    });
    let mut input = child
        .0
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("worker stdin missing"))?;
    let payload = serde_json::to_vec(&request.payload).map_err(io::Error::other)?;
    let writer = thread::spawn(move || input.write_all(&payload));
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("worker stdout missing"))?;
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(16_385).read_to_end(&mut bytes).and_then(|_| {
            if bytes.len() > 16_384 {
                Err(io::Error::other("worker response exceeds 16 KiB"))
            } else {
                Ok(bytes)
            }
        });
        let _ = sender.send(result);
    });
    let started = Instant::now();
    let result = (|| {
        loop {
            if cancelled.try_recv().is_ok() {
                return Err(io::Error::other("worker cancelled by API channel"));
            }
            if unsafe { WaitForSingleObject(parent.as_raw_handle(), 0) } != 258 {
                return Err(io::Error::other("parent API process exited"));
            }
            if started.elapsed() > Duration::from_millis(request.timeout_ms) {
                return Err(io::Error::other("worker wall-clock budget exceeded"));
            }
            if job.cpu_budget_exceeded()? {
                return Err(io::Error::other("worker CPU budget exceeded"));
            }
            if let Some(status) = child.0.try_wait()? {
                if !status.success() {
                    return Err(io::Error::other(format!(
                        "worker exited {status}; no artifact publication"
                    )));
                }
                // Worker 退出后先回收可能持有 stdout 的后代，再读取完整回执。
                job.terminate_and_wait()?;
                return receiver
                    .recv_timeout(Duration::from_millis(500))
                    .map_err(io::Error::other)?;
            }
            if let Ok(output) = receiver.try_recv() {
                let output = output?;
                // stdout 完整但 worker 未退出，仍不能提前发布。
                return wait_after_output(
                    output,
                    &mut child.0,
                    &parent,
                    &job,
                    started,
                    request.timeout_ms,
                    &cancelled,
                );
            }
            thread::sleep(Duration::from_millis(2));
        }
    })();
    let cleanup = job.terminate_and_wait();
    drop(job);
    drop(child);
    cleanup?;
    // 子进程已被 kill+wait,stderr 写端关闭,转发线程必然到达 EOF。
    if stderr_forwarder.join().is_err() {
        return Err(io::Error::other("worker stderr forwarder panicked"));
    }
    if writer.is_finished() {
        writer
            .join()
            .map_err(|_| io::Error::other("worker input writer panicked"))??;
    }
    if reader.is_finished() {
        let _ = reader.join();
    }
    let output = result?;
    io::stdout().write_all(&output)?;
    Ok(())
}

fn wait_after_output(
    bytes: Vec<u8>,
    child: &mut Child,
    parent: &OwnedHandle,
    job: &ProcessJob,
    started: Instant,
    timeout_ms: u64,
    cancelled: &mpsc::Receiver<()>,
) -> io::Result<Vec<u8>> {
    loop {
        if cancelled.try_recv().is_ok() {
            return Err(io::Error::other("worker cancelled by API channel"));
        }
        if unsafe { WaitForSingleObject(parent.as_raw_handle(), 0) } != 258 {
            return Err(io::Error::other("parent API process exited"));
        }
        if started.elapsed() > Duration::from_millis(timeout_ms) {
            return Err(io::Error::other("worker wall-clock budget exceeded"));
        }
        if job.cpu_budget_exceeded()? {
            return Err(io::Error::other("worker CPU budget exceeded"));
        }
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(bytes)
            } else {
                Err(io::Error::other(format!("worker exited {status}")))
            };
        }
        thread::sleep(Duration::from_millis(2));
    }
}
