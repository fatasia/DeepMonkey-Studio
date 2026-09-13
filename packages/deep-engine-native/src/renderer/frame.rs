use super::Renderer;
use crate::{
    events::RenderOutcome, gpu_submission::SubmissionCheck, mesh_pass::encode_mesh_passes,
    shadow_pass::encode_shadow_pass,
};

impl Renderer {
    pub fn render(&mut self, verify_submission: bool) -> RenderOutcome {
        if self.size.width == 0 || self.size.height == 0 {
            return RenderOutcome::Skipped;
        }
        let (output, suboptimal) = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(output) => (output, false),
            wgpu::CurrentSurfaceTexture::Suboptimal(output) => (output, true),
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return RenderOutcome::Skipped;
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return RenderOutcome::Skipped;
            }
            wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Validation => {
                return RenderOutcome::Recover;
            }
        };
        let check = verify_submission.then(|| SubmissionCheck::begin(&self.device));
        let view = output.texture.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Deep Engine native frame encoder"),
            });
        let culling_updated = self.culling.needs_encode();
        if culling_updated {
            self.culling.encode(&self.queue, &mut encoder);
        }
        let lod_updated = self.lod.as_ref().is_some_and(|lod| lod.needs_encode());
        if lod_updated {
            self.lod.as_ref().unwrap().encode(&self.queue, &mut encoder);
        }
        self.shadow_version.shader = self.scene.shader_revision;
        let shadow_updated = self.shadow_cache.needs_render(self.shadow_version);
        if shadow_updated {
            encode_shadow_pass(
                &mut encoder,
                &self.shadow_map,
                &self.scene,
                &self.culling,
                self.lod.as_ref(),
                &self.pipelines,
            );
        }
        encode_mesh_passes(
            &mut encoder,
            &self.forward_targets,
            &self.frame_bind_group,
            &self.scene,
            &self.culling,
            self.lod.as_ref(),
            &self.pipelines,
            self.yaw,
        );
        if let Some(probe) = &self.shadow_probe {
            probe.copy_shadowed(&mut encoder, self.forward_targets.resolved_texture());
        }
        if let Some(probe) = &self.ibl_probe {
            probe.copy_enabled(&mut encoder, self.forward_targets.resolved_texture());
        }
        if let Some(bloom) = &self.bloom {
            bloom.encode(&mut encoder);
        }
        self.output_pass.draw(&mut encoder, &view);
        if let Some(painter) = &self.deep2d {
            painter.draw(&mut encoder, &view);
        }
        if let Some(probe) = &self.shadow_probe {
            probe.clear_unshadowed_map(&mut encoder);
            encode_mesh_passes(
                &mut encoder,
                &self.forward_targets,
                probe.disabled_frame_bind_group(),
                &self.scene,
                &self.culling,
                self.lod.as_ref(),
                &self.pipelines,
                self.yaw,
            );
            probe.copy_unshadowed(&mut encoder, self.forward_targets.resolved_texture());
        }
        if let Some(probe) = &self.ibl_probe {
            encode_mesh_passes(
                &mut encoder,
                &self.forward_targets,
                probe.disabled_frame_bind_group(),
                &self.scene,
                &self.culling,
                self.lod.as_ref(),
                &self.pipelines,
                self.yaw,
            );
            probe.copy_disabled(&mut encoder, self.forward_targets.resolved_texture());
        }
        let submission = self.queue.submit([encoder.finish()]);
        if culling_updated {
            self.culling.commit_submission();
        }
        if lod_updated {
            self.lod.as_mut().unwrap().commit_submission();
        }
        if shadow_updated {
            self.shadow_cache.commit(self.shadow_version);
        }
        self.queue.present(output);
        if let Some(check) = check {
            if let Err(error) = check.finish(&self.device, submission, &self.failures) {
                return RenderOutcome::Failed(error);
            }
            println!("native smoke GPU submission complete: scopes=clean callbacks=clean");
        }
        match self.culling.take_metrics(&self.device) {
            Ok(Some(metrics)) => metrics.report(),
            Ok(None) => {}
            Err(error) => return RenderOutcome::Failed(error),
        }
        if let Some(probe) = &self.shadow_probe {
            match probe.finish(&self.device, self.shadow_version) {
                Ok(metrics) => {
                    println!(
                        "native shadow probe: version={:?} changed_pixels={} effect_hash={:016x} shadow_luminance={:.6} unshadowed_luminance={:.6}",
                        metrics.version,
                        metrics.changed_pixels,
                        metrics.shadow_effect_hash,
                        metrics.shadowed_luminance,
                        metrics.unshadowed_luminance
                    );
                    self.last_shadow_probe = Some(metrics);
                }
                Err(error) => return RenderOutcome::Failed(error),
            }
        }
        if let Some(probe) = &self.ibl_probe {
            match probe.finish(&self.device) {
                Ok(metrics) => println!(
                    "native IBL probe: changed_pixels={} enabled_luminance={:.6} disabled_luminance={:.6}",
                    metrics.changed_pixels, metrics.enabled_luminance, metrics.disabled_luminance
                ),
                Err(error) => return RenderOutcome::Failed(error),
            }
        }
        if suboptimal {
            self.surface.configure(&self.device, &self.config);
        }
        RenderOutcome::Presented
    }
}
