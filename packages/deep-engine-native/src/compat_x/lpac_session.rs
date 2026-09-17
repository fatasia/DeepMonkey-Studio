//! 同一个零 capability LPAC worker 顺序消费有界帧；任何失败均关闭整个会话。
use super::{launch, profile, *};
use crate::compat_x::process::frames::{
    MAX_SESSION_REQUESTS, SESSION_MAGIC, read_frame, write_frame,
};

pub struct Session {
    config: XProcessConfig,
    runtime: Option<Runtime>,
    completed: usize,
    process_id: u32,
}

struct Runtime {
    input: Option<mpsc::SyncSender<Vec<u8>>>,
    output: Option<mpsc::Receiver<Result<Vec<u8>, XProcessError>>>,
    writer: thread::JoinHandle<()>,
    reader: thread::JoinHandle<()>,
    child: launch::NativeChild,
    job: windows_job::ProcessJob,
    profile: profile::Profile,
}

impl Session {
    /// 仅可信宿主传入随包固定 worker；累计 Job CPU 限额不随 tick 重置。
    pub fn start(worker: &Path, config: XProcessConfig) -> Result<Self, XProcessError> {
        XCompatibilityHost::new(config.enabled, config.budget).map_err(XProcessError::Rejected)?;
        if !config.enabled {
            return Err(XProcessError::Rejected(XRejection::Disabled));
        }
        if config.lane != CompatibilityLane::ExperimentalX {
            return Err(XProcessError::Rejected(XRejection::NativeN0Isolated));
        }
        let job = windows_job::ProcessJob::new(config.process_limits).map_err(io_error)?;
        let mut profile = profile::Profile::new(worker).map_err(io_error)?;
        let (child, mut stdin, mut stdout) = launch::launch(&profile, job.raw_handle())
            .map_err(|error| io_error(profile.cleanup_after_error(error)))?;
        let process_id = child.process_id();
        let (input, requests) = mpsc::sync_channel::<Vec<u8>>(1);
        let (responses, output) = mpsc::sync_channel(1);
        let writer = thread::spawn(move || {
            if stdin.write_all(&SESSION_MAGIC).is_err() {
                return;
            }
            while let Ok(bytes) = requests.recv() {
                if write_frame(&mut stdin, &bytes).is_err() {
                    break;
                }
            }
        });
        let reader = thread::spawn(move || {
            loop {
                let result =
                    read_frame(&mut stdout).and_then(|bytes| bytes.ok_or(XProcessError::Crashed));
                let failed = result.is_err();
                if responses.send(result).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            config,
            runtime: Some(Runtime {
                input: Some(input),
                output: Some(output),
                writer,
                reader,
                child,
                job,
                profile,
            }),
            completed: 0,
            process_id,
        })
    }

    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    pub fn evaluate(
        &mut self,
        request: &XRequest,
        mut context: impl FnMut() -> XExecutionContext,
    ) -> Result<XCandidate, XProcessError> {
        let result = self.evaluate_inner(request, &mut context);
        if result.is_err() {
            self.close()?;
        }
        result
    }

    fn evaluate_inner(
        &mut self,
        request: &XRequest,
        context: &mut dyn FnMut() -> XExecutionContext,
    ) -> Result<XCandidate, XProcessError> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| io_error("X session is closed"))?;
        if self.completed >= MAX_SESSION_REQUESTS {
            return Err(io_error("X session request limit reached"));
        }
        let host = XCompatibilityHost::new(self.config.enabled, self.config.budget)
            .map_err(XProcessError::Rejected)?;
        let guard = |current| {
            host.guard(
                self.config.lane,
                request.expected_epoch,
                request.started_at_ms,
                current,
            )
            .map_err(XProcessError::Rejected)
        };
        let initial = context();
        guard(initial)?;
        check_depth(request, self.config.budget)?;
        let bytes = encode(&Envelope {
            version: X_COMPATIBILITY_SCHEMA_VERSION,
            budget: self.config.budget,
            request: request.clone(),
            context: initial,
        })?;
        let started = Instant::now();
        runtime
            .input
            .as_ref()
            .unwrap()
            .try_send(bytes)
            .map_err(io_error)?;
        loop {
            guard(context())?;
            if started.elapsed() > Duration::from_millis(self.config.budget.max_wall_clock_ms) {
                return Err(XProcessError::Rejected(XRejection::WallClockBudgetExceeded));
            }
            if runtime.job.cpu_budget_exceeded().map_err(io_error)? {
                return Err(XProcessError::ProcessCpuBudgetExceeded);
            }
            match runtime.output.as_ref().unwrap().try_recv() {
                Ok(bytes) => {
                    let candidate = validate_receipt(&bytes?, request, self.config.budget)?;
                    guard(context())?;
                    self.completed += 1;
                    return Ok(candidate);
                }
                Err(mpsc::TryRecvError::Disconnected) => return Err(XProcessError::Crashed),
                Err(mpsc::TryRecvError::Empty) => {}
            }
            thread::sleep(Duration::from_millis(1));
        }
    }

    pub fn close(&mut self) -> Result<(), XProcessError> {
        let Some(mut runtime) = self.runtime.take() else {
            return Ok(());
        };
        drop(runtime.input.take());
        drop(runtime.output.take());
        let cleanup = runtime.job.terminate_and_wait().map_err(io_error);
        drop(runtime.job);
        drop(runtime.child);
        let started = Instant::now();
        while !runtime.writer.is_finished() || !runtime.reader.is_finished() {
            if started.elapsed() > Duration::from_millis(250) {
                let _ = runtime.profile.cleanup();
                return Err(io_error("X session pipe cleanup timed out"));
            }
            thread::sleep(Duration::from_millis(1));
        }
        let writer = runtime.writer.join();
        let reader = runtime.reader.join();
        runtime.profile.cleanup().map_err(io_error)?;
        cleanup?;
        writer.map_err(|_| XProcessError::Crashed)?;
        reader.map_err(|_| XProcessError::Crashed)?;
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
