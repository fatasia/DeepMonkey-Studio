use std::time::Instant;

use super::Renderer;
use crate::{
    events::RenderOutcome,
    gpu_submission::SubmissionCheck,
    mesh_pass::{encode_opaque_pass, encode_transparent_pass},
    shadow_pass::encode_shadow_cascades,
    telemetry::{CpuSegment, FrameResult, FrameTelemetry, SampleToken},
    telemetry_gpu::GpuSegment,
};

impl Renderer {
    pub(super) fn render_internal(
        &mut self,
        verify_submission: bool,
        present: bool,
    ) -> RenderOutcome {
        let token = self.telemetry.as_mut().map(FrameTelemetry::begin_frame);
        if self.size.width == 0 || self.size.height == 0 {
            finish(&mut self.telemetry, token, FrameResult::Skipped);
            return RenderOutcome::Skipped;
        }

        let acquire = timer(token);
        let output = match self.acquire_frame_target(present) {
            Ok(output) => output,
            Err(outcome) => {
                record(&mut self.telemetry, token, CpuSegment::Acquire, acquire);
                let result = if matches!(outcome, RenderOutcome::Skipped) {
                    FrameResult::Skipped
                } else {
                    FrameResult::Recover
                };
                finish(&mut self.telemetry, token, result);
                return outcome;
            }
        };
        record(&mut self.telemetry, token, CpuSegment::Acquire, acquire);

        let check = verify_submission.then(|| SubmissionCheck::begin(&self.device));
        let view = output.view.clone();
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Deep Engine native frame encoder"),
            });
        if let (Some(telemetry), Some(token)) = (self.telemetry.as_mut(), token) {
            telemetry.gpu_begin_frame(token, &mut encoder);
        }

        let resources = timer(token);
        let culling_updated = self.culling.needs_encode();
        if culling_updated {
            self.culling.encode(&self.queue, &mut encoder);
        }
        let lod_updated = self.lod.as_ref().is_some_and(|lod| lod.needs_encode());
        if lod_updated {
            self.lod.as_ref().unwrap().encode(&self.queue, &mut encoder);
        }
        record(
            &mut self.telemetry,
            token,
            CpuSegment::SceneResources,
            resources,
        );

        self.shadow_version.shader = self.scene.shader_revision;
        let shadow_evidence = self.shadow_cache.plan(&self.shadow_keys);
        let shadow_updated = shadow_evidence.dirty_mask != 0;
        gpu_begin(&self.telemetry, GpuSegment::Shadow, &mut encoder);
        let shadow = timer(token).filter(|_| shadow_updated);
        if shadow_updated {
            encode_shadow_cascades(
                &mut encoder,
                &self.shadow_map,
                &self.scene,
                &self.culling,
                self.lod.as_ref(),
                &self.pipelines,
                shadow_evidence.dirty_mask,
            );
        }
        record(&mut self.telemetry, token, CpuSegment::Shadow, shadow);
        gpu_end(
            &mut self.telemetry,
            GpuSegment::Shadow,
            shadow_updated,
            &mut encoder,
        );

        gpu_begin(&self.telemetry, GpuSegment::Opaque, &mut encoder);
        let opaque = timer(token);
        encode_opaque_pass(
            &mut encoder,
            &self.forward_targets,
            &self.frame_bind_group,
            &self.scene,
            &self.culling,
            self.lod.as_ref(),
            &self.pipelines,
        );
        record(&mut self.telemetry, token, CpuSegment::Opaque, opaque);
        gpu_end(&mut self.telemetry, GpuSegment::Opaque, true, &mut encoder);

        let has_transparent = self.scene.has_transparent();
        gpu_begin(&self.telemetry, GpuSegment::Transparent, &mut encoder);
        let transparent = timer(token).filter(|_| has_transparent);
        encode_transparent_pass(
            &mut encoder,
            &self.forward_targets,
            &self.frame_bind_group,
            &self.scene,
            &self.culling,
            self.lod.as_ref(),
            &self.pipelines,
            self.yaw,
        );
        record(
            &mut self.telemetry,
            token,
            CpuSegment::Transparent,
            transparent,
        );
        gpu_end(
            &mut self.telemetry,
            GpuSegment::Transparent,
            has_transparent,
            &mut encoder,
        );

        if let Some(probe) = &self.shadow_probe {
            probe.copy_shadowed(&mut encoder, self.forward_targets.resolved_texture());
        }
        if let Some(probe) = &self.ibl_probe {
            probe.copy_enabled(&mut encoder, self.forward_targets.resolved_texture());
        }

        gpu_begin(&self.telemetry, GpuSegment::Postprocess, &mut encoder);
        let postprocess = timer(token);
        if let Some(bloom) = &self.bloom {
            bloom.encode(&mut encoder);
        }
        self.output_pass.draw(&mut encoder, &view);
        record(
            &mut self.telemetry,
            token,
            CpuSegment::Postprocess,
            postprocess,
        );
        gpu_end(
            &mut self.telemetry,
            GpuSegment::Postprocess,
            true,
            &mut encoder,
        );

        let has_deep2d = self.deep2d.is_some();
        gpu_begin(&self.telemetry, GpuSegment::Deep2d, &mut encoder);
        let deep2d = timer(token).filter(|_| has_deep2d);
        if let Some(painter) = &self.deep2d {
            painter.draw(&mut encoder, &view, (self.size.width, self.size.height));
        }
        record(&mut self.telemetry, token, CpuSegment::Deep2d, deep2d);
        gpu_end(
            &mut self.telemetry,
            GpuSegment::Deep2d,
            has_deep2d,
            &mut encoder,
        );

        super::frame_probes::encode_differential_probes(self, &mut encoder);
        if let (Some(telemetry), Some(token)) = (self.telemetry.as_mut(), token) {
            telemetry.gpu_finish_frame(token, &mut encoder);
        }
        let submit = timer(token);
        let submission = self.queue.submit([encoder.finish()]);
        if culling_updated {
            self.culling.commit_submission();
        }
        if lod_updated {
            self.lod.as_mut().unwrap().commit_submission();
        }
        if shadow_updated {
            self.shadow_cache.commit(&self.shadow_keys, shadow_evidence);
        }
        self.last_shadow_evidence = shadow_evidence;
        record(
            &mut self.telemetry,
            token,
            CpuSegment::SubmitPresent,
            submit,
        );

        if let Some(check) = check {
            if let Err(error) = check.finish(&self.device, submission, &self.failures) {
                finish(&mut self.telemetry, token, FrameResult::Failed);
                return RenderOutcome::Failed(error);
            }
            println!("native smoke GPU submission complete: scopes=clean callbacks=clean");
        }
        match self.culling.take_metrics(&self.device) {
            Ok(Some(metrics)) => metrics.report(),
            Ok(None) => {}
            Err(error) => {
                finish(&mut self.telemetry, token, FrameResult::Failed);
                return RenderOutcome::Failed(error);
            }
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
                Err(error) => {
                    finish(&mut self.telemetry, token, FrameResult::Failed);
                    return RenderOutcome::Failed(error);
                }
            }
        }
        if let Some(probe) = &self.ibl_probe {
            match probe.finish(&self.device) {
                Ok(metrics) => println!(
                    "native IBL probe: changed_pixels={} enabled_luminance={:.6} disabled_luminance={:.6}",
                    metrics.changed_pixels, metrics.enabled_luminance, metrics.disabled_luminance
                ),
                Err(error) => {
                    finish(&mut self.telemetry, token, FrameResult::Failed);
                    return RenderOutcome::Failed(error);
                }
            }
        }
        let suboptimal = output.suboptimal;
        output.present(&self.queue);
        if suboptimal {
            self.surface.configure(&self.device, &self.config);
        }
        finish(&mut self.telemetry, token, FrameResult::Presented);
        RenderOutcome::Presented
    }
}

fn timer(token: Option<SampleToken>) -> Option<Instant> {
    token.map(|_| Instant::now())
}

fn record(
    telemetry: &mut Option<FrameTelemetry>,
    token: Option<SampleToken>,
    segment: CpuSegment,
    start: Option<Instant>,
) {
    if let (Some(telemetry), Some(token)) = (telemetry.as_mut(), token) {
        telemetry.record(token, segment, start);
    }
}

fn finish(telemetry: &mut Option<FrameTelemetry>, token: Option<SampleToken>, result: FrameResult) {
    if let (Some(telemetry), Some(token)) = (telemetry.as_mut(), token) {
        telemetry.finish_frame(token, result);
    }
}

fn gpu_begin(
    telemetry: &Option<FrameTelemetry>,
    segment: GpuSegment,
    encoder: &mut wgpu::CommandEncoder,
) {
    if let Some(telemetry) = telemetry {
        telemetry.gpu_begin(segment, encoder);
    }
}

fn gpu_end(
    telemetry: &mut Option<FrameTelemetry>,
    segment: GpuSegment,
    active: bool,
    encoder: &mut wgpu::CommandEncoder,
) {
    if let Some(telemetry) = telemetry {
        telemetry.gpu_end(segment, active, encoder);
    }
}
