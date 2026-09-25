pub enum GpuEvent {
    DeviceLost {
        renderer_id: u64,
        reason: String,
        message: String,
    },
    UncapturedError {
        renderer_id: u64,
        message: String,
    },
    SmokeTimeout,
    /// Native product windows start hidden so pipeline compilation never
    /// exposes an unpainted client area. The first checkpoint runs the redraw
    /// transaction on the event-loop thread; the retry checkpoint bounds a
    /// failed presentation. The renderer id rejects stale rebuild checkpoints.
    #[cfg(not(target_arch = "wasm32"))]
    StartupFrameTimeout {
        renderer_id: u64,
        retry: bool,
    },
    /// wasm:wgpu web 后端异步初始化完成的回装事件。Renderer 不要求 Send
    /// (web 事件循环与初始化同线程)。
    #[cfg(target_arch = "wasm32")]
    WasmRendererReady,
    /// Studio keeps Three/WebGL as the authoring authority and forwards the
    /// latest camera to the WASM presentation surface.
    #[cfg(target_arch = "wasm32")]
    WasmCamera {
        position: [f32; 3],
        target: [f32; 3],
        focal: f32,
        near: f32,
        far: f32,
    },
    /// Replace the active browser runtime package without creating a second
    /// event loop. The renderer is rebuilt on the same canvas and the author
    /// surface stays visible until the ready generation advances.
    #[cfg(target_arch = "wasm32")]
    WasmScenePackage(Vec<u8>),
    #[cfg(target_arch = "wasm32")]
    WasmEditorOverlay { revision: u64, vertices: Vec<f32> },
    #[cfg(target_arch = "wasm32")]
    WasmStop,
    /// A watched RenderPacket file changed and validated; the payload carries the
    /// fully prepared content and a monotonic watcher generation. Delivery is
    /// best-effort: closing the window drops pending updates and keeps the last
    /// correct frame.
    PacketArrived,
    PackageArrived,
    PackageOpened,
    LiveProbeCheckpoint,
    #[cfg(windows)]
    XReady,
}

pub fn targets_active_renderer(active_renderer_id: Option<u64>, renderer_id: u64) -> bool {
    active_renderer_id == Some(renderer_id)
}

pub enum RenderOutcome {
    Presented,
    Skipped,
    Recover,
    Failed(String),
}

#[cfg(test)]
mod tests {
    use super::targets_active_renderer;

    #[test]
    fn gpu_callbacks_only_target_the_renderer_that_published_them() {
        assert!(targets_active_renderer(Some(4), 4));
        assert!(!targets_active_renderer(Some(4), 3));
        assert!(!targets_active_renderer(None, 4));
    }
}
