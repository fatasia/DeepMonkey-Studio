use super::*;

#[cfg(target_arch = "wasm32")]
thread_local! {
    static WASM_RENDERER_RESULT: std::cell::RefCell<Option<Result<Renderer, String>>> = const { std::cell::RefCell::new(None) };
}

impl NativeApp {
    pub(super) fn initialize_renderer(&mut self) {
        let Some(window) = self.window.as_ref() else {
            return;
        };
        let renderer_id = self.next_renderer_id;
        self.next_renderer_id = self
            .next_renderer_id
            .checked_add(1)
            .expect("renderer generation exhausted");
        #[cfg(not(target_arch = "wasm32"))]
        let replacing_live_renderer = self.renderer.is_some();
        #[cfg(target_arch = "wasm32")]
        {
            if self.renderer_initializing {
                return;
            }
            self.renderer_initializing = true;
            crate::app_startup::begin_wasm_renderer_attempt();
            let window = window.clone();
            let proxy = self.proxy.clone();
            let content = self.content.snapshot();
            let view = self.state.view;
            let features = self.features.for_content(content.as_ref());
            wasm_bindgen_futures::spawn_local(async move {
                let result = Renderer::new(
                    window,
                    proxy.clone(),
                    renderer_id,
                    content.as_ref(),
                    view,
                    features,
                )
                .await;
                // `send_event` may synchronously re-enter winit's web loop.
                // Release the immutable startup snapshot before publishing the
                // completion event so redraw/tick handlers can mutate content.
                drop(content);
                WASM_RENDERER_RESULT.with(|slot| *slot.borrow_mut() = Some(result));
                // `spawn_local` schedules the notification for a later
                // microtask. The outer initialization future (and all borrows
                // held by Renderer::new) is gone before winit can re-enter.
                wasm_bindgen_futures::spawn_local(async move {
                    let _ = proxy.send_event(GpuEvent::WasmRendererReady);
                });
            });
            return;
        }
        #[cfg(not(target_arch = "wasm32"))]
        match pollster::block_on(Renderer::new(
            window.clone(),
            self.proxy.clone(),
            renderer_id,
            self.content.active(),
            self.state.view,
            self.features.for_content(self.content.active()),
        )) {
            Ok(renderer) => {
                let renderer_id = renderer.id();
                self.state.renderer_ready();
                report_renderer_ready(&renderer);
                // P1-19:图表内容才需要字体,因此能力探测只在此时做一次。
                // 探测要遍历系统字体库(实测约 9ms),不放进无文本场景的启动路径。
                if self.content.active().chart.is_some() {
                    let capability = self
                        .chart_text
                        .get_or_insert_with(Default::default)
                        .font_capability();
                    println!("native font capability: {}", capability.summary());
                    for face in capability.faces.iter().take(8) {
                        println!(
                            "native font face: family={} postscript={} weight={} italic={} mono={} hash={:016x} bytes={}",
                            face.identity.family,
                            face.identity.post_script_name,
                            face.identity.weight,
                            face.identity.italic,
                            face.identity.monospaced,
                            face.identity.content_hash,
                            face.identity.content_bytes
                        );
                    }
                    if capability.faces.len() > 8 {
                        println!(
                            "native font capability: {} more faces omitted",
                            capability.faces.len() - 8
                        );
                    }
                }
                self.renderer = Some(renderer);
                self.startup_frame_pending = !self.smoke_frame && self.state.verification.is_none();
                crate::window_chrome::set_title(window, "");
                if self.startup_frame_pending {
                    // Hidden Windows windows do not reliably receive an OS
                    // RedrawRequested. Queue a user event immediately so the
                    // first render still runs on the event-loop thread.
                    let _ = self.proxy.send_event(GpuEvent::StartupFrameTimeout {
                        renderer_id,
                        retry: false,
                    });
                } else {
                    window.request_redraw();
                }
            }
            Err(error) => {
                eprintln!("{error}");
                self.startup_frame_pending = false;
                if self.smoke_frame || !replacing_live_renderer {
                    self.state.failed(error);
                }
                if replacing_live_renderer {
                    crate::window_chrome::set_title(
                        window,
                        "Deep Engine Native Viewer — rebuild rejected, previous frame retained",
                    );
                    window.request_redraw();
                } else {
                    crate::window_chrome::set_title(
                        window,
                        "Deep Engine Native Viewer — GPU initialization failed (press R)",
                    );
                    // Initial candidates are hidden until first present; expose
                    // an initialization failure so retry/diagnostics remain usable.
                    window.set_visible(true);
                }
            }
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn finish_wasm_renderer(&mut self) {
        self.renderer_initializing = false;
        if std::mem::take(&mut self.deferred_layout_bump)
            && let Err(error) = self.content.active_mut().epoch.bump_layout()
        {
            self.state.failed(error);
        }
        let Some(result) = WASM_RENDERER_RESULT.with(|slot| slot.borrow_mut().take()) else {
            self.state
                .failed("wasm renderer completion event has no result".into());
            return;
        };
        let Some(window) = self.window.as_ref() else {
            return;
        };
        match result {
            Ok(renderer) => {
                if self.content.active().chart.is_some() {
                    match deep_engine_native::platform_text::runtime_text_rasterizer() {
                        Ok(rasterizer) => self.chart_text = Some(rasterizer),
                        Err(error) => {
                            self.state.failed(error.clone());
                            crate::window_chrome::set_title(
                                window,
                                "Deep Engine Web Viewer — runtime fonts unavailable",
                            );
                            eprintln!("{error}");
                            return;
                        }
                    }
                }
                self.state.renderer_ready();
                report_renderer_ready(&renderer);
                self.renderer = Some(renderer);
                crate::app_startup::mark_wasm_renderer_ready();
                crate::window_chrome::set_title(window, "");
                window.request_redraw();
            }
            Err(error) => {
                self.state.failed(error.clone());
                crate::app_startup::mark_wasm_renderer_failed(error.clone());
                crate::window_chrome::set_title(
                    window,
                    "Deep Engine Web Viewer — GPU initialization failed",
                );
                eprintln!("{error}");
            }
        }
    }
}
