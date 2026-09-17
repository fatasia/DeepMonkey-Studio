//! 单次、封闭 ABI 子进程。进程故障隔离不等同于 OS 权限沙箱。
use super::{host, *};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub const MAX_IPC_BYTES: usize = 4 * 1024 * 1024;

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
    WorkerRejected(String),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    budget: XBudget,
    request: XRequest,
    context: XExecutionContext,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    result: Result<WireCandidate, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireCandidate {
    expected_epoch: u64,
    started_at_ms: u64,
    messages: Vec<XMessage>,
    request_hash: String,
    output_hash: String,
}

impl From<XCandidate> for WireCandidate {
    fn from(value: XCandidate) -> Self {
        Self {
            expected_epoch: value.expected_epoch,
            started_at_ms: value.started_at_ms,
            messages: value.messages,
            request_hash: value.request_hash,
            output_hash: value.output_hash,
        }
    }
}

fn io_error(error: impl std::fmt::Display) -> XProcessError {
    XProcessError::Io(error.to_string())
}

fn read_bounded(input: impl Read) -> Result<Vec<u8>, XProcessError> {
    let mut bytes = Vec::new();
    input
        .take((MAX_IPC_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_IPC_BYTES {
        return Err(XProcessError::IpcBudgetExceeded);
    }
    Ok(bytes)
}

struct LimitedBuffer(Vec<u8>);
impl Write for LimitedBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_IPC_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("X IPC budget exceeded"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>, XProcessError> {
    let mut buffer = LimitedBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, value).map_err(|_| XProcessError::IpcBudgetExceeded)?;
    Ok(buffer.0)
}

/// Worker 的唯一入口：一次请求、一次回执；不接受源码或注入宿主对象。
pub fn serve(input: impl Read, mut output: impl Write) -> Result<(), XProcessError> {
    let bytes = read_bounded(input)?;
    let envelope: Envelope = serde_json::from_slice(&bytes).map_err(io_error)?;
    if envelope.version != X_COMPATIBILITY_SCHEMA_VERSION {
        return Err(XProcessError::InvalidReceipt);
    }
    let result = XCompatibilityHost::new(true, envelope.budget)
        .and_then(|host| {
            host.evaluate(
                CompatibilityLane::ExperimentalX,
                &envelope.request,
                envelope.context,
            )
        })
        .map(WireCandidate::from)
        .map_err(|error| format!("{error:?}"));
    let receipt = encode(&Receipt {
        version: X_COMPATIBILITY_SCHEMA_VERSION,
        result,
    })?;
    output.write_all(&receipt).map_err(io_error)?;
    output.flush().map_err(io_error)
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
    mut command: Command,
    enabled: bool,
    lane: CompatibilityLane,
    budget: XBudget,
    request: &XRequest,
    mut context: impl FnMut() -> XExecutionContext,
) -> Result<XCandidate, XProcessError> {
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
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = RunningChild(command.spawn().map_err(io_error)?);
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
    drop(child);
    let candidate = result?;
    // 非内置程序可能派生继承管道的进程，子进程退出并不保证 EOF。
    // 回执等待和线程收尾均不得越过宿主 deadline；OS 进程树资源治理另行接线。
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

fn validate_receipt(
    bytes: &[u8],
    request: &XRequest,
    budget: XBudget,
) -> Result<XCandidate, XProcessError> {
    let receipt: Receipt =
        serde_json::from_slice(bytes).map_err(|_| XProcessError::InvalidReceipt)?;
    if receipt.version != X_COMPATIBILITY_SCHEMA_VERSION {
        return Err(XProcessError::InvalidReceipt);
    }
    let candidate = receipt.result.map_err(XProcessError::WorkerRejected)?;
    let request_hash =
        crate::shader_package::hash::hash_canonical(&host::request_hash_value(request));
    let messages = serde_json::Value::Array(
        candidate
            .messages
            .iter()
            .map(host::message_hash_value)
            .collect(),
    );
    let output_hash = crate::shader_package::hash::hash_canonical(&messages);
    if candidate.expected_epoch != request.expected_epoch
        || candidate.started_at_ms != request.started_at_ms
        || candidate.request_hash != request_hash
        || candidate.output_hash != output_hash
        || candidate.messages.len() > budget.max_messages
        || candidate
            .messages
            .iter()
            .map(host::message_bytes)
            .sum::<usize>()
            > budget.max_message_bytes
    {
        return Err(XProcessError::InvalidReceipt);
    }
    Ok(XCandidate {
        expected_epoch: candidate.expected_epoch,
        started_at_ms: candidate.started_at_ms,
        messages: candidate.messages,
        request_hash: candidate.request_hash,
        output_hash: candidate.output_hash,
    })
}
