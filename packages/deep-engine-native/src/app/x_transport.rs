//! 单在途窗口求值；LPAC 会话仅由后台线程拥有。
use deep_engine_native::compat_x::{
    XDynamicContent, XExecutionContext,
    process::XProcessConfig,
    scheduler::{XContentScheduler, XPublishedOutput, XTickBinding},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender},
};
use std::thread::JoinHandle;
use winit::event_loop::EventLoopProxy;

pub(super) struct Receipt {
    pub output: XPublishedOutput,
    pub process_id: Option<u32>,
}

pub(super) struct Transport {
    sender: Option<SyncSender<XTickBinding>>,
    receiver: Receiver<Result<Receipt, String>>,
    cancelled: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    in_flight: bool,
}

impl Transport {
    pub fn start(
        template: Arc<XDynamicContent>,
        proxy: EventLoopProxy<crate::events::GpuEvent>,
    ) -> Result<Self, String> {
        let (sender, requests) = mpsc::sync_channel::<XTickBinding>(1);
        let (results, receiver) = mpsc::sync_channel(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let thread = std::thread::Builder::new()
            .name("x-window-evaluator".into())
            .spawn(move || {
                let mut scheduler = XContentScheduler::new(XProcessConfig {
                    enabled: true,
                    ..Default::default()
                });
                while let Ok(binding) = requests.recv() {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let epoch = binding.epoch;
                    let started_at_ms = binding.started_at_ms;
                    let started = std::time::Instant::now();
                    let result = match scheduler.as_mut() {
                        Ok(scheduler) => scheduler
                            .dispatch_tick(&template, binding, || XExecutionContext {
                                current_epoch: epoch,
                                now_ms: started_at_ms.saturating_add(
                                    started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                ),
                                cancelled: stop.load(Ordering::Acquire),
                            })
                            .cloned()
                            .map(|output| Receipt {
                                output,
                                process_id: scheduler.worker_process_id(),
                            })
                            .map_err(|error| format!("X tick rejected: {error:?}")),
                        Err(error) => Err(format!("X scheduler unavailable: {error:?}")),
                    };
                    let failed = result.is_err();
                    // 不阻塞发送，关闭窗口无需等待 UI 消费回执。
                    if stop.load(Ordering::Acquire) || results.try_send(result).is_err() {
                        break;
                    }
                    let _ = proxy.send_event(crate::events::GpuEvent::XReady);
                    if failed {
                        break;
                    }
                }
                if let Ok(mut scheduler) = scheduler
                    && let Err(error) = scheduler.close_session()
                {
                    eprintln!("X window worker cleanup failed: {error:?}");
                }
            })
            .map_err(|error| format!("X evaluator thread unavailable: {error}"))?;
        Ok(Self {
            sender: Some(sender),
            receiver,
            cancelled,
            thread: Some(thread),
            in_flight: false,
        })
    }

    pub fn submit(&mut self, binding: XTickBinding) -> Result<(), String> {
        if self.in_flight {
            return Err("X evaluator already has an in-flight tick".into());
        }
        self.sender
            .as_ref()
            .ok_or("X evaluator closed")?
            .try_send(binding)
            .map_err(|error| format!("X tick enqueue failed: {error}"))?;
        self.in_flight = true;
        Ok(())
    }

    pub fn poll(&mut self) -> Option<Result<Receipt, String>> {
        if !self.in_flight {
            return None;
        }
        match self.receiver.try_recv() {
            Ok(result) => {
                self.in_flight = false;
                Some(result)
            }
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => {
                self.in_flight = false;
                Some(Err("X evaluator stopped without a receipt".into()))
            }
        }
    }

    pub fn busy(&self) -> bool {
        self.in_flight
    }

    pub fn close(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.in_flight = false;
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.close();
    }
}
