//! Browser physics packet updates await GPU completion without blocking winit.

use super::*;

thread_local! {
    static RESULTS: std::cell::RefCell<std::collections::BTreeMap<u64, (Renderer, Result<crate::renderer::StagedRenderPacketUpdate, String>)>> =
        std::cell::RefCell::new(std::collections::BTreeMap::new());
}

impl NativeApp {
    pub(super) fn begin_wasm_physics_stage(
        &mut self,
        previous: deep_engine_native::contract::RenderPacket,
    ) {
        let Some(renderer) = self.renderer.take() else {
            return;
        };
        self.physics_stage_epoch = self.physics_stage_epoch.wrapping_add(1);
        let epoch = self.physics_stage_epoch;
        self.physics_stage_pending = true;
        let content = self.content.snapshot();
        let proxy = self.proxy.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let staged = renderer
                .stage_render_packet_update(&previous, content.as_ref())
                .await;
            // The event-loop callback may mutate PublishedState only after its
            // immutable GPU staging snapshot has been released.
            drop(content);
            RESULTS.with(|results| {
                results.borrow_mut().insert(epoch, (renderer, staged));
            });
            wasm_bindgen_futures::spawn_local(async move {
                let _ = proxy.send_event(GpuEvent::WasmPhysicsFrameReady { epoch });
            });
        });
    }

    pub(super) fn finish_wasm_physics_stage(&mut self, epoch: u64, event_loop: &ActiveEventLoop) {
        let result = RESULTS.with(|results| results.borrow_mut().remove(&epoch));
        if epoch != self.physics_stage_epoch {
            return;
        }
        self.physics_stage_pending = false;
        match result {
            Some((mut renderer, Ok(staged))) => {
                if let Err(error) = renderer.publish_render_packet_update(staged) {
                    self.renderer = Some(renderer);
                    crate::app_startup::mark_wasm_renderer_failed(error.clone());
                    self.state.failed(error);
                    event_loop.exit();
                    return;
                }
                self.renderer = Some(renderer);
                self.physics_present_pending = true;
                self.request_redraw();
            }
            Some((renderer, Err(error))) => {
                self.renderer = Some(renderer);
                crate::app_startup::mark_wasm_renderer_failed(error.clone());
                self.state.failed(error);
                event_loop.exit();
            }
            None => {
                self.state
                    .failed("WASM physics stage completion is missing".into());
                event_loop.exit();
            }
        }
    }
}
