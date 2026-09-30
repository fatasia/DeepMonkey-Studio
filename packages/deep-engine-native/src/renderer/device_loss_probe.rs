//! Test-only observations on the actual product renderer; no replacement GPU path.
use super::*;
use crate::{events::RenderOutcome, hdr_readback::HdrReadbackPair};

impl Renderer {
    pub(crate) fn device_loss_probe_presented_hdr(&mut self) -> f64 {
        assert!(matches!(self.render(true), RenderOutcome::Presented));
        let capture = HdrReadbackPair::new(&self.device, self.size, "window device recovery");
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let texture = self.forward_targets.resolved_texture();
        capture.copy_first(&mut encoder, texture);
        capture.copy_second(&mut encoder, texture);
        self.queue.submit([encoder.finish()]);
        let observed = capture
            .finish(&self.device, "window device recovery")
            .unwrap();
        assert_eq!(observed.changed_pixels, 0);
        assert!(observed.first_luminance.is_finite() && observed.first_luminance > 1.0);
        self.failures.check().unwrap();
        observed.first_luminance
    }

    pub(crate) fn device_loss_probe_destroy(&self) {
        self.device.destroy();
        let _ = self.device.poll(wgpu::PollType::Poll);
    }
}
