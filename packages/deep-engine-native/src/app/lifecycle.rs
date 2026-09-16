use super::*;

impl ApplicationHandler<GpuEvent> for NativeApp {
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        package_open::flush_drop(self);
        chart_sim::tick(self, event_loop);
    }
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_none() {
            let attributes = window_attributes(self.smoke_frame);
            match event_loop.create_window(attributes) {
                Ok(window) => self.window = Some(Arc::new(window)),
                Err(error) => {
                    self.state.failure = Some(format!("native window creation failed: {error}"));
                    event_loop.exit();
                    return;
                }
            }
        }
        if self.renderer.is_none() {
            self.initialize_renderer();
            if self.smoke_frame && self.state.failure.is_some() {
                event_loop.exit();
                return;
            }
        }
        if self.smoke_frame {
            let proxy = self.proxy.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let _ = proxy.send_event(GpuEvent::SmokeTimeout);
            });
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: GpuEvent) {
        if recovery::handle(self, event_loop, &event) {
            return;
        }
        match event {
            GpuEvent::PacketArrived => packet_live::apply_latest(self),
            GpuEvent::PackageArrived => package_live::apply_latest(self),
            GpuEvent::PackageOpened => package_open::apply_latest(self),
            GpuEvent::LiveProbeCheckpoint => {
                let result = self
                    .packet_live_probe
                    .as_mut()
                    .zip(self.renderer.as_ref())
                    .ok_or_else(|| {
                        "live reload rejection checkpoint has no active probe/renderer".to_owned()
                    })
                    .and_then(|(probe, renderer)| probe.after_rejection_checkpoint(renderer));
                if let Err(error) = result {
                    self.state.failed(error);
                    event_loop.exit();
                }
            }
            _ => {}
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        window_events::handle(self, event_loop, window_id, event);
    }
}
