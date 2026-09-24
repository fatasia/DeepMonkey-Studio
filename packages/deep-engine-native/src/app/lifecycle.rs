use super::*;

impl ApplicationHandler<GpuEvent> for NativeApp {
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        // Also refresh newly opened packages whose initial CPU content is 1x.
        text_scale::refresh(self);
        #[cfg(windows)]
        accessibility::sync(self);
        package_open::flush_drop(self);
        if packet_live::retry(self, event_loop, std::time::Instant::now()) {
            return;
        }
        if package_live::retry(self, event_loop, std::time::Instant::now()) {
            return;
        }
        #[cfg(windows)]
        if x_runtime::tick(self, event_loop) {
            return;
        }
        if self.content.active().dashboard.is_some() {
            dashboard::tick(self, event_loop);
        } else {
            chart_sim::tick(self, event_loop);
        }
        let dynamic_wake = self
            .product_dynamic_playback
            .as_ref()
            .and_then(|playback| playback.wake_at());
        let physics_wake = self
            .product_physics_playback
            .as_ref()
            .map(|playback| playback.wake_at());
        if let Some(wake_at) = dynamic_wake.into_iter().chain(physics_wake).min() {
            let now = std::time::Instant::now();
            if now >= wake_at {
                self.request_redraw();
            }
            event_loop
                .set_control_flow({
            #[cfg(not(target_arch = "wasm32"))]
            let flow = winit::event_loop::ControlFlow::WaitUntil(wake_at.max(now));
            #[cfg(target_arch = "wasm32")]
            let flow = crate::wasm_compat::control_flow_until(wake_at.max(now));
            flow
                });
        }
    }
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_none() {
            let attributes = crate::player_diagnostics::telemetry_surface_size()
                .filter(|_| self.telemetry_sample_frames_remaining > 0)
                .map_or_else(
                    || window_attributes(self.smoke_frame),
                    |size| {
                        window_attributes(self.smoke_frame)
                            .with_inner_size(size)
                            .with_min_inner_size(size)
                    },
                );
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
            // smoke 与发布验证都必须 fail-fast:初始化失败即退出事件循环,
            // 让 run_internal 的 failure 检查转成非零退出;否则验证模式下
            // ControlFlow::Wait 等不到事件,进程挂到验证器超时被杀。
            if (self.smoke_frame || self.state.verification.is_some())
                && self.state.failure.is_some()
            {
                event_loop.exit();
                return;
            }
        }
        text_scale::refresh(self);
        if self.smoke_frame {
            let proxy = self.proxy.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let _ = proxy.send_event(GpuEvent::SmokeTimeout);
            });
        }
        #[cfg(windows)]
        accessibility::attach(self);
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: GpuEvent) {
        if recovery::handle(self, event_loop, &event) {
            return;
        }
        match event {
            #[cfg(windows)]
            GpuEvent::XReady => {
                x_runtime::tick(self, event_loop);
            }
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
