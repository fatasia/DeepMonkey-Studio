//! GPU device-loss and error recovery decisions for the native viewer.
//! Split from `app.rs` so recovery semantics own one boundary.

use winit::event_loop::ActiveEventLoop;

use crate::events::{GpuEvent, targets_active_renderer};

use super::{NativeApp, Renderer};

/// Handles the renderer-scoped recovery events. Returns `true` when the event was
/// consumed and the caller must not treat it as a live-packet update.
pub(super) fn handle(app: &mut NativeApp, event_loop: &ActiveEventLoop, event: &GpuEvent) -> bool {
    match event {
        #[cfg(windows)]
        GpuEvent::XReady => false,
        GpuEvent::DeviceLost {
            renderer_id,
            reason,
            message,
        } => {
            if !targets_active_renderer(app.renderer.as_ref().map(Renderer::id), *renderer_id) {
                return true;
            }
            if app.smoke_frame || app.state.verification.is_some() {
                app.state.failure = Some(format!(
                    "GPU device lost during native verification frame ({reason}): {message}"
                ));
                event_loop.exit();
                return true;
            }
            eprintln!("GPU device lost ({reason}): {message}; rebuilding native renderer");
            app.renderer = None;
            app.initialize_renderer();
            true
        }
        GpuEvent::UncapturedError {
            renderer_id,
            message,
        } => {
            if !targets_active_renderer(app.renderer.as_ref().map(Renderer::id), *renderer_id) {
                return true;
            }
            if app.smoke_frame || app.state.verification.is_some() {
                app.state.failure = Some(format!(
                    "uncaptured GPU error during native verification frame: {message}"
                ));
                event_loop.exit();
                return true;
            }
            app.state.failed(format!("uncaptured GPU error: {message}"));
            eprintln!("uncaptured GPU error: {message}");
            if let Some(window) = app.window.as_ref() {
                crate::window_chrome::set_title(
                    window,
                    "Deep Engine Native Viewer — GPU error (press R to rebuild)",
                );
            }
            true
        }
        GpuEvent::SmokeTimeout => {
            if app.smoke_frame || app.state.verification.is_some() {
                app.state.failure =
                    Some("native verification frame timed out before present".into());
                event_loop.exit();
            }
            true
        }
        GpuEvent::PacketArrived
        | GpuEvent::PackageArrived
        | GpuEvent::PackageOpened
        | GpuEvent::LiveProbeCheckpoint => false,
    }
}
