use std::sync::Arc;

use winit::{
    application::ApplicationHandler,
    event::{ElementState, WindowEvent},
    event_loop::{ActiveEventLoop, EventLoopProxy},
    keyboard::{KeyCode, PhysicalKey},
    window::{Window, WindowId},
};

use crate::{
    app_startup::{report_presented, report_renderer_ready, window_attributes},
    events::{GpuEvent, RenderOutcome, targets_active_renderer},
    player_content::PlayerContent,
    player_state::PlayerState,
    renderer::{Renderer, RendererFeatures},
};
mod runner;
mod shadow_update_probe;
pub use runner::{run, run_shadow_update_probe};
use shadow_update_probe::ShadowUpdateProbe;

struct NativeApp {
    content: PlayerContent,
    proxy: EventLoopProxy<GpuEvent>,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    next_renderer_id: u64,
    smoke_frame: bool,
    features: RendererFeatures,
    shadow_update_probe: Option<ShadowUpdateProbe>,
    state: PlayerState,
}

impl NativeApp {
    fn new(
        content: PlayerContent,
        proxy: EventLoopProxy<GpuEvent>,
        smoke_frame: bool,
        features: RendererFeatures,
        shadow_update_probe: Option<ShadowUpdateProbe>,
    ) -> Self {
        Self {
            content,
            proxy,
            window: None,
            renderer: None,
            next_renderer_id: 1,
            smoke_frame,
            features,
            shadow_update_probe,
            state: PlayerState::default(),
        }
    }

    fn initialize_renderer(&mut self) {
        let Some(window) = self.window.as_ref() else {
            return;
        };
        let renderer_id = self.next_renderer_id;
        self.next_renderer_id = self
            .next_renderer_id
            .checked_add(1)
            .expect("renderer generation exhausted");
        let replacing_live_renderer = self.renderer.is_some();
        match pollster::block_on(Renderer::new(
            window.clone(),
            self.proxy.clone(),
            renderer_id,
            &self.content,
            self.state.view,
            self.features,
        )) {
            Ok(renderer) => {
                self.state.renderer_ready();
                report_renderer_ready(&renderer);
                self.renderer = Some(renderer);
                let title = if self.content.deep2d.is_some() {
                    "Deep Engine Native Viewer — native wgpu 3D + Deep2d"
                } else {
                    "Deep Engine Native Viewer — native wgpu renderer"
                };
                window.set_title(title);
                window.request_redraw();
            }
            Err(error) => {
                eprintln!("{error}");
                if self.smoke_frame || !replacing_live_renderer {
                    self.state.failed(error);
                }
                if replacing_live_renderer {
                    window.set_title(
                        "Deep Engine Native Viewer — rebuild rejected, previous frame retained",
                    );
                    window.request_redraw();
                } else {
                    window.set_title(
                        "Deep Engine Native Viewer — GPU initialization failed (press R)",
                    );
                }
            }
        }
    }

    fn rotate(&mut self, delta: f32) {
        self.state.rotate(delta);
        if let Some(renderer) = self.renderer.as_mut() {
            renderer.set_view(self.state.view);
        }
        self.request_redraw();
    }

    fn request_redraw(&self) {
        if let Some(window) = self.window.as_ref() {
            window.request_redraw();
        }
    }

    fn resize(&mut self, size: winit::dpi::PhysicalSize<u32>) {
        if let Some(error) = self
            .renderer
            .as_mut()
            .and_then(|renderer| renderer.resize(size).err())
        {
            self.state.failed(error);
        }
        self.request_redraw();
    }
}

impl ApplicationHandler<GpuEvent> for NativeApp {
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
        match event {
            GpuEvent::DeviceLost {
                renderer_id,
                reason,
                message,
            } => {
                if !targets_active_renderer(self.renderer.as_ref().map(Renderer::id), renderer_id) {
                    return;
                }
                if self.smoke_frame {
                    self.state.failure = Some(format!(
                        "GPU device lost during smoke frame ({reason}): {message}"
                    ));
                    event_loop.exit();
                    return;
                }
                eprintln!("GPU device lost ({reason}): {message}; rebuilding native renderer");
                self.renderer = None;
                self.initialize_renderer();
            }
            GpuEvent::UncapturedError {
                renderer_id,
                message,
            } => {
                if !targets_active_renderer(self.renderer.as_ref().map(Renderer::id), renderer_id) {
                    return;
                }
                if self.smoke_frame {
                    self.state.failure = Some(format!(
                        "uncaptured GPU error during smoke frame: {message}"
                    ));
                    event_loop.exit();
                    return;
                }
                self.state
                    .failed(format!("uncaptured GPU error: {message}"));
                eprintln!("uncaptured GPU error: {message}");
                if let Some(window) = self.window.as_ref() {
                    window.set_title("Deep Engine Native Viewer — GPU error (press R to rebuild)");
                }
            }
            GpuEvent::SmokeTimeout if self.smoke_frame => {
                self.state.failure = Some("native smoke frame timed out before present".into());
                event_loop.exit();
            }
            GpuEvent::SmokeTimeout => {}
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if self
            .window
            .as_ref()
            .is_none_or(|window| window.id() != window_id)
        {
            return;
        }
        match event {
            WindowEvent::CloseRequested => {
                if self.smoke_frame {
                    self.state
                        .failed("native smoke window closed before GPU completion".into());
                }
                event_loop.exit();
            }
            WindowEvent::Resized(size) => self.resize(size),
            WindowEvent::ScaleFactorChanged { .. } => {
                if let Some(size) = self.window.as_ref().map(|window| window.inner_size()) {
                    self.resize(size);
                }
            }
            WindowEvent::Occluded(false) => self.request_redraw(),
            WindowEvent::RedrawRequested => {
                let outcome = self
                    .renderer
                    .as_mut()
                    .map(|renderer| renderer.render(self.smoke_frame));
                if let Some(RenderOutcome::Failed(error)) = outcome.as_ref() {
                    self.state.failure = Some(error.clone());
                    event_loop.exit();
                    return;
                }
                if self.smoke_frame && matches!(outcome, Some(RenderOutcome::Presented)) {
                    if let Some(probe) = self.shadow_update_probe.as_mut() {
                        let result = probe.after_present(
                            self.renderer.as_mut().expect("renderer exists"),
                            &mut self.content,
                        );
                        match result {
                            Ok(false) => {
                                self.request_redraw();
                                return;
                            }
                            Ok(true) => {}
                            Err(error) => {
                                self.state.failure = Some(error);
                                event_loop.exit();
                                return;
                            }
                        }
                    }
                    let size = self.window.as_ref().expect("window exists").inner_size();
                    report_presented(size, self.content.deep2d.is_some());
                    event_loop.exit();
                    return;
                }
                if self.smoke_frame && matches!(outcome, Some(RenderOutcome::Skipped)) {
                    self.request_redraw();
                }
                if matches!(outcome, Some(RenderOutcome::Recover)) {
                    if self.smoke_frame {
                        self.state.failure =
                            Some("surface was lost during native smoke frame".into());
                        event_loop.exit();
                        return;
                    }
                    self.renderer = None;
                    self.initialize_renderer();
                }
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed && !event.repeat =>
            {
                match event.physical_key {
                    PhysicalKey::Code(KeyCode::Escape) => event_loop.exit(),
                    PhysicalKey::Code(KeyCode::ArrowLeft) => self.rotate(-0.18),
                    PhysicalKey::Code(KeyCode::ArrowRight) => self.rotate(0.18),
                    PhysicalKey::Code(KeyCode::KeyR) => self.initialize_renderer(),
                    _ => {}
                }
            }
            _ => {}
        }
    }
}
