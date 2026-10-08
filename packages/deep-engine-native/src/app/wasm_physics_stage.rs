//! Browser physics packet updates await GPU completion without blocking winit.

use super::*;

thread_local! {
    static RESULTS: std::cell::RefCell<std::collections::BTreeMap<u64, (Renderer, Result<crate::renderer::StagedRenderPacketUpdate, String>, Option<PlayerContent>)>> =
        std::cell::RefCell::new(std::collections::BTreeMap::new());
}

impl NativeApp {
    pub(super) fn begin_wasm_package_stage(&mut self, content: PlayerContent) -> Result<(), PlayerContent> {
        let compatible = self.renderer.as_ref().is_some_and(|renderer| !renderer.requires_content_rebuild(&content))
            // Independently compiled snapshots can reuse revision 0/1. Prove
            // immutable resource equality before entering revision-based paths.
            && self.content.active().packet().geometries == content.packet().geometries
            && self.content.active().packet().textures == content.packet().textures
            && self.content.active().runtime_package().zip(content.runtime_package()).is_some_and(|(before, after)| {
                // These are independently validated full snapshots, not a delta:
                // the editor may emit a changed RenderPacket at revision 1. Only
                // resources outside the renderer transaction must be identical.
                let external = |index: &[deep_engine_native::runtime_package::RuntimeResourceIndexEntry]| {
                    index.iter().filter(|entry| !matches!(entry.kind,
                        deep_engine_native::runtime_package::RuntimeResourceKind::RenderPacket
                        | deep_engine_native::runtime_package::RuntimeResourceKind::ShaderPackage))
                        .cloned().collect::<Vec<_>>()
                };
                deep_engine_native::runtime_package::plan_runtime_package_resource_diff(
                    &external(&before.resource_index), &external(&after.resource_index))
                    .is_ok_and(|plan| plan.is_empty())
            });
        if !compatible { return Err(content); }
        let renderer = self.renderer.take().expect("compatible renderer");
        self.physics_stage_epoch = self.physics_stage_epoch.wrapping_add(1);
        let epoch = self.physics_stage_epoch;
        self.physics_stage_pending = true;
        crate::app_startup::begin_wasm_renderer_attempt();
        let previous = self.content.snapshot();
        let proxy = self.proxy.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let staged = renderer.stage_render_packet_update(previous.packet(), &content).await;
            drop(previous);
            RESULTS.with(|results| { results.borrow_mut().insert(epoch, (renderer, staged, Some(content))); });
            wasm_bindgen_futures::spawn_local(async move {
                let _ = proxy.send_event(GpuEvent::WasmPhysicsFrameReady { epoch });
            });
        });
        Ok(())
    }

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
                results.borrow_mut().insert(epoch, (renderer, staged, None));
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
            Some((mut renderer, Ok(staged), content)) => {
                if let Err(error) = renderer.publish_render_packet_update(staged) {
                    self.renderer = Some(renderer);
                    crate::app_startup::mark_wasm_renderer_failed(error.clone());
                    if content.is_some() { self.request_redraw(); return; }
                    self.state.failed(error);
                    event_loop.exit();
                    return;
                }
                if let Some(content) = content {
                    let view = content.view_after_reload(self.content.active(), self.state.view);
                    let controls = content.camera_controls();
                    self.product_physics_playback = super::dynamic_playback::ProductPhysicsPlayback::for_content(&content);
                    self.content = PublishedState::new(content);
                    self.state.set_camera(view, controls);
                    renderer.set_view(self.state.view);
                    crate::app_startup::mark_wasm_renderer_ready();
                }
                self.renderer = Some(renderer);
                self.physics_present_pending = true;
                self.request_redraw();
            }
            Some((renderer, Err(error), content)) => {
                self.renderer = Some(renderer);
                crate::app_startup::mark_wasm_renderer_failed(error.clone());
                if content.is_some() { self.request_redraw(); return; }
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
