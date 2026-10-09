use super::Renderer;

impl Renderer {
    /// Allocate once when a staged scene first introduces physical transmission.
    pub(super) fn ensure_transmission_source(&mut self) {
        if self.scene.has_transmission() && self.forward_targets.scene_opaque_view.is_none() {
            self.forward_targets.enable_transmission(&self.device);
            self.bind_transmission_source();
        }
    }

    pub(super) fn bind_transmission_source(&mut self) {
        self.ibl
            .set_scene_opaque_view(self.forward_targets.scene_opaque_view.as_ref());
        self.frame_bind_group = self.ibl.create_frame_bind_group(
            &self.device,
            &self.frame_layout,
            &self.frame_buffer,
            Some(&self.ies_buffer),
            &self.shadow_map,
            Some(&self.probe_frame_buffer),
            "Native transmission frame bindings",
            true,
        );
        self.rt_frame_bind_group = self
            .rt_residency
            .as_ref()
            .and_then(|residency| self.rt_frame_bind_group_resource(residency));
    }
}
