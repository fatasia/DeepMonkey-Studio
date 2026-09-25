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
        #[cfg(not(target_arch = "wasm32"))]
        GpuEvent::StartupFrameTimeout { renderer_id, retry } => {
            let active_renderer_id = app.renderer.as_ref().map(Renderer::id);
            match startup_timeout_decision(
                app.startup_frame_pending,
                active_renderer_id,
                *renderer_id,
                *retry,
            ) {
                StartupTimeoutDecision::Ignore => {}
                StartupTimeoutDecision::RevealAndRetry => {
                    if let Some(window) = app.window.as_ref() {
                        eprintln!(
                            "native first frame rendering on the event loop before window publication"
                        );
                        crate::window_chrome::set_title(
                            window,
                            "Deep Engine Native Viewer — first frame delayed, retrying",
                        );
                    }
                    super::window_events::force_startup_redraw(app, event_loop);
                    if app.startup_frame_pending {
                        let proxy = app.proxy.clone();
                        let renderer_id = *renderer_id;
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(2));
                            let _ = proxy.send_event(GpuEvent::StartupFrameTimeout {
                                renderer_id,
                                retry: true,
                            });
                        });
                    }
                }
                StartupTimeoutDecision::ReportStalled => {
                    let error = "native first frame did not present after the visible redraw retry";
                    eprintln!("{error}");
                    app.state.failed(error.into());
                    app.startup_frame_pending = false;
                    if let Some(window) = app.window.as_ref() {
                        crate::window_chrome::set_title(
                            window,
                            "Deep Engine Native Viewer — first frame stalled (press R to rebuild)",
                        );
                        window.set_visible(true);
                    }
                }
            }
            true
        }
        GpuEvent::PacketArrived
        | GpuEvent::PackageArrived
        | GpuEvent::PackageOpened
        | GpuEvent::LiveProbeCheckpoint => false,
        #[cfg(target_arch = "wasm32")]
        GpuEvent::WasmRendererReady
        | GpuEvent::WasmCamera { .. }
        | GpuEvent::WasmScenePackage(_)
        | GpuEvent::WasmEditorOverlay { .. }
        | GpuEvent::WasmStop => false,
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupTimeoutDecision {
    Ignore,
    RevealAndRetry,
    ReportStalled,
}

#[cfg(not(target_arch = "wasm32"))]
fn startup_timeout_decision(
    pending: bool,
    active_renderer_id: Option<u64>,
    event_renderer_id: u64,
    retry: bool,
) -> StartupTimeoutDecision {
    if !pending || active_renderer_id != Some(event_renderer_id) {
        return StartupTimeoutDecision::Ignore;
    }
    if retry {
        StartupTimeoutDecision::ReportStalled
    } else {
        StartupTimeoutDecision::RevealAndRetry
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::{StartupTimeoutDecision, startup_timeout_decision};

    #[test]
    fn startup_timeout_only_reveals_the_current_hidden_pending_candidate() {
        assert_eq!(
            startup_timeout_decision(true, Some(7), 7, false),
            StartupTimeoutDecision::RevealAndRetry
        );
        assert_eq!(
            startup_timeout_decision(true, Some(7), 7, true),
            StartupTimeoutDecision::ReportStalled
        );
        assert_eq!(
            startup_timeout_decision(false, Some(7), 7, false),
            StartupTimeoutDecision::Ignore
        );
        assert_eq!(
            startup_timeout_decision(true, Some(8), 7, false),
            StartupTimeoutDecision::Ignore
        );
    }
}
