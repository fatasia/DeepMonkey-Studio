use super::*;

impl ApplicationHandler<GpuEvent> for NativeApp {
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        // Renderer::new is genuinely asynchronous in browsers and retains an
        // immutable content snapshot. Do not run mutable content schedulers
        // until that snapshot is released by the completion event.
        #[cfg(target_arch = "wasm32")]
        if self.renderer_initializing {
            return;
        }
        // Also refresh newly opened packages whose initial CPU content is 1x.
        text_scale::refresh(self);
        #[cfg(windows)]
        accessibility::sync(self);
        package_open::flush_drop(self);
        #[cfg(not(target_arch = "wasm32"))]
        {
            if packet_live::retry(self, event_loop, web_time::Instant::now()) {
                return;
            }
            if package_live::retry(self, event_loop, web_time::Instant::now()) {
                return;
            }
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
            let now = web_time::Instant::now();
            if now >= wake_at {
                self.request_redraw();
            }
            event_loop
                .set_control_flow(winit::event_loop::ControlFlow::WaitUntil(wake_at.max(now)));
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
            // Normal player windows are presentation candidates. Keep them
            // hidden while Renderer::new compiles pipelines. Smoke and explicit
            // publication-verification windows must stay compositor-backed:
            // hidden Windows windows do not reliably receive RedrawRequested,
            // and verification intentionally uses its existing fail-fast path
            // instead of the product first-frame watchdog.
            #[cfg(not(target_arch = "wasm32"))]
            let attributes =
                attributes.with_visible(self.smoke_frame || self.state.verification.is_some());
            match event_loop.create_window(attributes) {
                Ok(window) => {
                    #[cfg(windows)]
                    if !self.smoke_frame
                        && self.state.verification.is_none()
                        && let Err(error) = crate::window_chrome::disable_show_transition(&window)
                    {
                        eprintln!("native first-frame DWM transition disable failed: {error}");
                    }
                    #[cfg(target_arch = "wasm32")]
                    crate::app_startup::remember_wasm_window_canvas(&window);
                    self.window = Some(Arc::new(window));
                }
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
        #[cfg(not(target_arch = "wasm32"))]
        if self.smoke_frame || self.state.verification.is_some() {
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
            #[cfg(target_arch = "wasm32")]
            GpuEvent::WasmRendererReady => self.finish_wasm_renderer(),
            #[cfg(target_arch = "wasm32")]
            GpuEvent::WasmCamera {
                position,
                target,
                focal,
                near,
                far,
            } => match self.state.view.with_eye_target(position, target) {
                Ok(mut view)
                    if focal.is_finite()
                        && focal > 0.0
                        && near.is_finite()
                        && near > 0.0
                        && far.is_finite()
                        && far > near =>
                {
                    view.focal = focal;
                    view.near = near;
                    view.far = far;
                    self.state.view = view;
                    match wasm_camera_presentation(self.renderer.is_some()) {
                        WasmCameraPresentation::Immediate => {
                            self.renderer
                                .as_mut()
                                .expect("ready WASM camera renderer")
                                .set_view(self.state.view);
                            window_events::present_wasm_camera(self, event_loop);
                        }
                        WasmCameraPresentation::Deferred => self.request_redraw(),
                    }
                }
                Ok(_) => crate::app_startup::mark_wasm_renderer_failed(
                    "WASM camera projection values must be finite and ordered".into(),
                ),
                Err(error) => crate::app_startup::mark_wasm_renderer_failed(error),
            },
            #[cfg(target_arch = "wasm32")]
            GpuEvent::WasmScenePackage(bytes) => {
                match crate::runtime_package_startup::load_bytes(&bytes) {
                    Ok(package) => {
                        let content = package.into_content();
                        let view =
                            content.view_after_reload(self.content.active(), self.state.view);
                        let controls = content.camera_controls();
                        self.renderer = None;
                        self.content = PublishedState::new(content);
                        self.state.set_camera(view, controls);
                        self.initialize_renderer();
                    }
                    Err(error) => crate::app_startup::mark_wasm_renderer_failed(error),
                }
            }
            #[cfg(target_arch = "wasm32")]
            GpuEvent::WasmEditorOverlay { revision, vertices } => {
                if let Some(renderer) = self.renderer.as_mut() {
                    match renderer.set_editor_overlay(&vertices, revision) {
                        Ok(()) => self.request_redraw(),
                        Err(error) => crate::app_startup::mark_wasm_renderer_failed(error),
                    }
                }
            }
            #[cfg(target_arch = "wasm32")]
            GpuEvent::WasmStop => event_loop.exit(),
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

#[cfg(any(test, target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WasmCameraPresentation {
    Immediate,
    Deferred,
}

#[cfg(any(test, target_arch = "wasm32"))]
fn wasm_camera_presentation(renderer_ready: bool) -> WasmCameraPresentation {
    if renderer_ready {
        WasmCameraPresentation::Immediate
    } else {
        WasmCameraPresentation::Deferred
    }
}

#[cfg(test)]
mod wasm_camera_presentation_tests {
    use super::{WasmCameraPresentation, wasm_camera_presentation};

    #[test]
    fn ready_camera_event_presents_without_a_second_event_loop_turn() {
        assert_eq!(
            wasm_camera_presentation(true),
            WasmCameraPresentation::Immediate
        );
        assert_eq!(
            wasm_camera_presentation(false),
            WasmCameraPresentation::Deferred
        );
    }
}
