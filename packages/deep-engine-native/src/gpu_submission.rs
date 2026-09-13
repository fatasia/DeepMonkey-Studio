use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

/// 回调直接记录失败，烟测不依赖尚未被窗口事件循环消费的消息。
#[derive(Clone, Default)]
pub struct GpuFailures(Arc<Mutex<Option<String>>>);

impl GpuFailures {
    pub fn record(&self, error: String) {
        let mut first = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        first.get_or_insert(error);
    }

    pub fn check(&self) -> Result<(), String> {
        let first = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        first.clone().map_or(Ok(()), Err)
    }
}

pub struct SubmissionCheck {
    validation: wgpu::ErrorScopeGuard,
    memory: wgpu::ErrorScopeGuard,
    internal: wgpu::ErrorScopeGuard,
}

impl SubmissionCheck {
    pub fn begin(device: &wgpu::Device) -> Self {
        Self {
            validation: device.push_error_scope(wgpu::ErrorFilter::Validation),
            memory: device.push_error_scope(wgpu::ErrorFilter::OutOfMemory),
            internal: device.push_error_scope(wgpu::ErrorFilter::Internal),
        }
    }

    pub fn finish(
        self,
        device: &wgpu::Device,
        submission: wgpu::SubmissionIndex,
        failures: &GpuFailures,
    ) -> Result<(), String> {
        let completion = device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(5)),
        });
        let errors = [
            pollster::block_on(self.internal.pop()),
            pollster::block_on(self.memory.pop()),
            pollster::block_on(self.validation.pop()),
        ];
        completion.map_err(|error| format!("native GPU submission did not complete: {error}"))?;
        if let Some(error) = errors.into_iter().flatten().next() {
            return Err(format!("native GPU submission rejected: {error}"));
        }
        failures
            .check()
            .map_err(|error| format!("native GPU callback failed: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{GpuFailures, SubmissionCheck};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[test]
    fn callback_failure_is_observable_before_ui_dispatch_and_does_not_cross_devices() {
        let first_device = GpuFailures::default();
        let callback = first_device.clone();
        std::thread::spawn(move || {
            callback.record("device lost after submit".into());
            callback.record("secondary validation error".into());
        })
        .join()
        .expect("callback thread");
        let replacement = GpuFailures::default();
        assert_eq!(
            first_device.check().unwrap_err(),
            "device lost after submit"
        );
        assert!(replacement.check().is_ok());
    }

    #[test]
    #[ignore = "requires a real GPU; run explicitly with --ignored"]
    fn submission_fence_waits_and_rejects_scoped_and_uncaptured_gpu_faults() {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        }))
        .expect("real GPU adapter");
        let (device, queue) = pollster::block_on(adapter.request_device(&Default::default()))
            .expect("real GPU device");
        let failures = GpuFailures::default();
        let callback_failures = failures.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            callback_failures.record(error.to_string());
        }));
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("submission fence workload"),
            size: 4096,
            usage: wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let check = SubmissionCheck::begin(&device);
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.clear_buffer(&buffer, 0, None);
        let index = queue.submit([encoder.finish()]);
        let completed = Arc::new(AtomicBool::new(false));
        let callback_completed = completed.clone();
        queue.on_submitted_work_done(move || callback_completed.store(true, Ordering::SeqCst));
        check
            .finish(&device, index, &failures)
            .expect("valid GPU submission");
        assert!(
            completed.load(Ordering::SeqCst),
            "GPU completion callback must have run"
        );

        let check = SubmissionCheck::begin(&device);
        let invalid = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scoped failure injection"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.clear_buffer(&invalid, 0, None);
        let index = queue.submit([encoder.finish()]);
        let error = check
            .finish(&device, index, &failures)
            .expect_err("reject invalid clear");
        assert!(error.contains("native GPU submission"), "{error}");
        assert!(
            failures.check().is_ok(),
            "scoped fault must stay in its scope"
        );

        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.clear_buffer(&invalid, 0, None);
        drop(encoder.finish());
        let check = SubmissionCheck::begin(&device);
        let index = queue.submit([]);
        let error = check
            .finish(&device, index, &failures)
            .expect_err("reject callback fault");
        assert!(error.contains("native GPU callback failed"), "{error}");
        println!(
            "Native submission completion/fault checks passed: {:?}",
            adapter.get_info()
        );
    }
}
