//! 单次、封闭 ABI 子进程。进程故障隔离不等同于 OS 权限沙箱。
use super::{host, *};
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[path = "process_ipc.rs"]
mod ipc;
pub use ipc::serve;
#[path = "process_frames.rs"]
mod frames;
pub use frames::serve_worker;
use ipc::{encode, io_error, read_bounded, validate_receipt, Envelope};

pub const MAX_IPC_BYTES: usize = 4 * 1024 * 1024;

#[cfg(windows)]
#[path = "windows_job.rs"]
pub(crate) mod windows_job;
#[cfg(windows)]
pub use windows_job::XProcessLimits;

#[cfg(windows)]
#[path = "lpac.rs"]
pub mod lpac;

#[derive(Debug, Clone, Copy)]
pub struct XProcessConfig {
    pub enabled: bool,
    pub lane: CompatibilityLane,
    pub budget: XBudget,
    #[cfg(windows)]
    pub process_limits: XProcessLimits,
}

impl Default for XProcessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            lane: CompatibilityLane::ExperimentalX,
            budget: XBudget::default(),
            #[cfg(windows)]
            process_limits: XProcessLimits::default(),
        }
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;

#[derive(Debug, PartialEq, Eq)]
pub enum XProcessError {
    Rejected(XRejection),
    Io(String),
    Crashed,
    InvalidReceipt,
    IpcBudgetExceeded,
    ProcessCpuBudgetExceeded,
    WorkerRejected(String),
}

struct RunningChild(Child);
impl Drop for RunningChild {
    fn drop(&mut self) {
        // 包括取消、超时和损坏回执：始终终止并回收，不留下后台求值器。
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// command 必须由可信宿主构造，指向随包交付的 worker；不得来自脚本输入。
/// 返回候选仍须经 XCompatibilityHost::publish 的第二次 epoch/取消校验。
pub fn evaluate_in_process(
    command: Command,
    enabled: bool,
    lane: CompatibilityLane,
    budget: XBudget,
    request: &XRequest,
    context: impl FnMut() -> XExecutionContext,
) -> Result<XCandidate, XProcessError> {
    evaluate_with_config(
        command,
        XProcessConfig {
            enabled,
            lane,
            budget,
            ..Default::default()
        },
        request,
        context,
    )
}

pub fn evaluate_with_config(
    mut command: Command,
    config: XProcessConfig,
    request: &XRequest,
    mut context: impl FnMut() -> XExecutionContext,
) -> Result<XCandidate, XProcessError> {
    let (enabled, lane, budget) = (config.enabled, config.lane, config.budget);
    let host = XCompatibilityHost::new(enabled, budget).map_err(XProcessError::Rejected)?;
    let initial = context();
    host.guard(lane, request.expected_epoch, request.started_at_ms, initial)
        .map_err(XProcessError::Rejected)?;
    check_depth(request, budget)?;
    let envelope = Envelope {
        version: X_COMPATIBILITY_SCHEMA_VERSION,
        budget,
        request: request.clone(),
        context: initial,
    };
    let input = encode(&envelope)?;
    let started = Instant::now();
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    #[cfg(windows)]
    let job = windows_job::ProcessJob::new(config.process_limits).map_err(io_error)?;
    let mut child = RunningChild(command.spawn().map_err(io_error)?);
    #[cfg(windows)]
    job.assign_and_resume(&child.0).map_err(io_error)?;
    let mut stdin = child.0.stdin.take().ok_or(XProcessError::InvalidReceipt)?;
    let stdout = child.0.stdout.take().ok_or(XProcessError::InvalidReceipt)?;
    // 两个管道并发推进，避免大请求/回执互相填满造成死锁。
    let writer = thread::spawn(move || stdin.write_all(&input));
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        let _ = sender.send(read_bounded(stdout));
    });
    let result = (|| {
        let mut received = None;
        loop {
            host.guard(
                lane,
                request.expected_epoch,
                request.started_at_ms,
                context(),
            )
            .map_err(XProcessError::Rejected)?;
            if started.elapsed() > Duration::from_millis(budget.max_wall_clock_ms) {
                return Err(XProcessError::Rejected(XRejection::WallClockBudgetExceeded));
            }
            #[cfg(windows)]
            if job.cpu_budget_exceeded().map_err(io_error)? {
                return Err(XProcessError::ProcessCpuBudgetExceeded);
            }
            if received.is_none() {
                match receiver.try_recv() {
                    Ok(bytes) => received = Some(bytes?),
                    Err(mpsc::TryRecvError::Empty) => {}
                    Err(mpsc::TryRecvError::Disconnected) => return Err(XProcessError::Crashed),
                }
            }
            if let Some(status) = child.0.try_wait().map_err(io_error)? {
                if !status.success() {
                    return Err(XProcessError::Crashed);
                }
                if let Some(bytes) = received.take() {
                    return validate_receipt(&bytes, request, budget);
                }
            }
            thread::sleep(Duration::from_millis(2));
        }
    })();
    #[cfg(windows)]
    let cleanup = job.terminate_and_wait().map_err(io_error);
    #[cfg(windows)]
    drop(job);
    drop(child);
    // Windows Job先终止持有管道的进程树；收尾仍不无界阻塞宿主。
    #[cfg(windows)]
    {
        cleanup?;
        let cleanup_started = Instant::now();
        while !writer.is_finished() || !reader.is_finished() {
            if cleanup_started.elapsed() > Duration::from_millis(250) {
                return Err(io_error("X worker pipe cleanup timed out"));
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
    let candidate = result?;
    if writer.is_finished() {
        writer
            .join()
            .map_err(|_| XProcessError::Crashed)?
            .map_err(io_error)?;
    }
    if reader.is_finished() {
        reader.join().map_err(|_| XProcessError::Crashed)?;
    }
    host.guard(
        lane,
        request.expected_epoch,
        request.started_at_ms,
        context(),
    )
    .map_err(XProcessError::Rejected)?;
    Ok(candidate)
}

pub(crate) fn encode_bounded_request(
    request: &XRequest,
    budget: XBudget,
) -> Result<Vec<u8>, XProcessError> {
    check_depth(request, budget)?;
    encode(request)
}

fn check_depth(request: &XRequest, budget: XBudget) -> Result<(), XProcessError> {
    // 在递归 JSON 编码/hash 之前检查深度与节点数。
    let mut pending: Vec<_> = request.calls.iter().map(|call| (call, 1)).collect();
    let mut count = 0;
    while let Some((call, depth)) = pending.pop() {
        count += 1;
        if count > budget.max_cpu_units {
            return Err(XProcessError::Rejected(XRejection::CpuBudgetExceeded));
        }
        if depth > budget.max_call_depth {
            return Err(XProcessError::Rejected(XRejection::CallDepthExceeded));
        }
        if let XCall::Sequence(calls) = call {
            pending.extend(calls.iter().map(|call| (call, depth + 1)));
        }
    }
    Ok(())
}
