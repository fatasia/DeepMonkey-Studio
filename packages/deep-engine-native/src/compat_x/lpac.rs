//! LPAC实验入口，只允许可信宿主指定固定可执行文件；零capabilities，无降级。
use super::*;
use std::{io::Write, path::Path};
#[path = "lpac_launch.rs"]
mod launch;
#[path = "lpac_profile.rs"]
mod profile;
#[path = "lpac_session.rs"]
mod session;
pub use session::Session;

pub fn evaluate(
    worker: &Path,
    config: XProcessConfig,
    request: &XRequest,
    mut context: impl FnMut() -> XExecutionContext,
) -> Result<XCandidate, XProcessError> {
    let host =
        XCompatibilityHost::new(config.enabled, config.budget).map_err(XProcessError::Rejected)?;
    let initial = context();
    host.guard(
        config.lane,
        request.expected_epoch,
        request.started_at_ms,
        initial,
    )
    .map_err(XProcessError::Rejected)?;
    check_depth(request, config.budget)?;
    let input = encode(&Envelope {
        version: X_COMPATIBILITY_SCHEMA_VERSION,
        budget: config.budget,
        request: request.clone(),
        context: initial,
    })?;
    let output = exchange(worker, &input, config, || {
        host.guard(
            config.lane,
            request.expected_epoch,
            request.started_at_ms,
            context(),
        )
        .map_err(XProcessError::Rejected)
    })?;
    let candidate = validate_receipt(&output, request, config.budget)?;
    host.guard(
        config.lane,
        request.expected_epoch,
        request.started_at_ms,
        context(),
    )
    .map_err(XProcessError::Rejected)?;
    Ok(candidate)
}

/// 限于可信封闭实验probe的字节通道；资源/命令均不得由X脚本指定。
pub fn exchange(
    worker: &Path,
    input: &[u8],
    config: XProcessConfig,
    mut guard: impl FnMut() -> Result<(), XProcessError>,
) -> Result<Vec<u8>, XProcessError> {
    XCompatibilityHost::new(config.enabled, config.budget).map_err(XProcessError::Rejected)?;
    if !config.enabled {
        return Err(XProcessError::Rejected(XRejection::Disabled));
    }
    if config.lane != CompatibilityLane::ExperimentalX {
        return Err(XProcessError::Rejected(XRejection::NativeN0Isolated));
    }
    if input.len() > MAX_IPC_BYTES {
        return Err(XProcessError::IpcBudgetExceeded);
    }
    guard()?;
    let started = Instant::now();
    let job = windows_job::ProcessJob::new(config.process_limits).map_err(io_error)?;
    let mut profile = profile::Profile::new(worker).map_err(io_error)?;
    let (child, mut stdin, stdout) = match launch::launch(&profile, job.raw_handle()) {
        Ok(child) => child,
        Err(error) => return Err(io_error(profile.cleanup_after_error(error))),
    };
    let input = input.to_owned();
    let writer = thread::spawn(move || stdin.write_all(&input));
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        let _ = sender.send(read_bounded(stdout));
    });
    let result = (|| {
        let mut received = None;
        loop {
            guard()?;
            if started.elapsed() > Duration::from_millis(config.budget.max_wall_clock_ms) {
                return Err(XProcessError::Rejected(XRejection::WallClockBudgetExceeded));
            }
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
            if let Some(success) = child.exited().map_err(io_error)? {
                if !success {
                    return Err(XProcessError::Crashed);
                }
                if let Some(bytes) = received.take() {
                    return Ok(bytes);
                }
            }
            thread::sleep(Duration::from_millis(2));
        }
    })();
    let tree_cleanup = job.terminate_and_wait().map_err(io_error);
    drop(job);
    drop(child);
    let cleanup_started = Instant::now();
    while (!writer.is_finished() || !reader.is_finished())
        && cleanup_started.elapsed() < Duration::from_millis(250)
    {
        thread::sleep(Duration::from_millis(1));
    }
    profile.cleanup().map_err(io_error)?;
    tree_cleanup?;
    if !writer.is_finished() || !reader.is_finished() {
        return Err(io_error("LPAC pipe cleanup timed out"));
    }
    let written = writer.join().map_err(|_| XProcessError::Crashed)?;
    reader.join().map_err(|_| XProcessError::Crashed)?;
    let output = result?;
    written.map_err(io_error)?;
    guard()?;
    Ok(output)
}
