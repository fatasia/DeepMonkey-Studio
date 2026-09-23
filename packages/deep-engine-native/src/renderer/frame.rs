use std::time::Instant;

use super::Renderer;
use crate::{
    events::RenderOutcome,
    gpu_submission::SubmissionCheck,
    mesh_pass::{encode_opaque_pass, encode_opaque_pass_rt, encode_outline_mask, encode_transparent_pass},
    shadow_pass::{
        CascadeScene, CascadeShadowTimestamps, encode_shadow_cascades_parallel,
        shadow_executor_threads,
    },
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
        #[cfg(windows)]
        if let (Some(video), Some(painter)) = (&mut self.dashboard_video, &self.deep2d) {
            if let Err(error) = video
                .sync_slots(
                    &self.device,
                    painter.dashboard_video_slots(),
                    painter.logical_size(),
                )
                .and_then(|_| {
                    video.update_frame_uniform(&self.queue, (self.size.width, self.size.height));
                    video.advance(&self.queue).map(|_| ())
                })
            {
                finish(&mut self.telemetry, token, FrameResult::Failed);
                return RenderOutcome::Failed(format!(
                    "native dashboard video frame update failed: {error}"
                ));
            }
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

        // 波次5:Native RenderGraph 真多线程 command 编码。阴影级联是帧内
        // 互相独立的编码单元族(各写各自 texture array layer),派发
        // executor 线程并行编码;产物按级联升序与 pre/主 CB 一起进单次
        // submit —— wgpu 队列对单次 submit 内的 command buffer 保证 FIFO
        // 执行序,因此 GPU 观察序与串行一致,阴影贴图逐位相同。
        self.shadow_version.shader = self.scene.shader_revision;
        let shadow_evidence = self.shadow_cache.plan(&self.shadow_keys);
        let shadow_updated = shadow_evidence.dirty_mask != 0;
        let parallel_shadow = shadow_updated;

        // 并行路径下 culling/lod 的 compute 必须先于级联 CB 执行(级联的
        // indirect draw 消费其结果):单次 submit 内 command buffer 按序
        // 执行,所以把它们放进 pre CB。
        let mut pre_encoder = parallel_shadow.then(|| {
            self.device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Deep Engine native frame pre-encoder"),
                })
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Deep Engine native frame encoder"),
            });

        // Frame 起点时间戳路由:pre CB 存在时写在 pre CB;否则延迟由首个
        // 级联 CB 携带;串行路径维持写在帧主 encoder。GPU 时间线语义与
        // 串行布局等价(Frame 段仍覆盖整帧)。
        if parallel_shadow {
            match pre_encoder.as_mut() {
                Some(pre) => {
                    if let (Some(telemetry), Some(token)) = (self.telemetry.as_mut(), token) {
                        telemetry.gpu_begin_frame(token, pre);
                    }
                }
                None => {
                    if let (Some(telemetry), Some(token)) = (self.telemetry.as_mut(), token) {
                        telemetry.gpu_begin_frame_deferred(token);
                    }
                }
            }
        } else if let (Some(telemetry), Some(token)) = (self.telemetry.as_mut(), token) {
            telemetry.gpu_begin_frame(token, &mut encoder);
        }

        let resources = timer(token);
        let culling_updated = self.culling.needs_encode();
        if culling_updated {
            match pre_encoder.as_mut() {
                Some(pre) => self.culling.encode(&self.queue, pre),
                None => self.culling.encode(&self.queue, &mut encoder),
            }
        }
        let lod_updated = self.lod.as_ref().is_some_and(|lod| lod.needs_encode());
        if lod_updated && let Some(lod) = self.lod.as_ref() {
            match pre_encoder.as_mut() {
                Some(pre) => lod.encode(&self.queue, pre),
                None => lod.encode(&self.queue, &mut encoder),
            }
        }
        record(
            &mut self.telemetry,
            token,
            CpuSegment::SceneResources,
            resources,
        );

        let shadow_started = timer(token);
        let mut shadow_buffers = Vec::new();
        if parallel_shadow {
            // stamper 借用 self.telemetry(共享),最后一次使用在下面的并行
            // 编码调用里;随后才能再做 &mut telemetry 的采样落账。
            let stamper = self
                .telemetry
                .as_ref()
                .and_then(FrameTelemetry::gpu_segment_stamper);
            let timestamps = stamper.as_ref().map(|stamper| CascadeShadowTimestamps {
                stamper,
                frame_begin_on_first: pre_encoder.is_none(),
            });
            let shadow_scene = CascadeScene {
                shadow_map: &self.shadow_map,
                scene: &self.scene,
                culling: &self.culling,
                lod: self.lod.as_ref(),
                pipelines: &self.pipelines,
            };
            match encode_shadow_cascades_parallel(
                &self.device,
                shadow_executor_threads(),
                &shadow_scene,
                shadow_evidence.dirty_mask,
                timestamps,
            ) {
                Ok(buffers) => shadow_buffers = buffers,
                Err(error) => {
                    // 错误传播取消整批:本帧任何 command buffer 都不提交,
                    // 阴影提交状态不推进(commit 只发生在 submit 之后)。
                    record(
                        &mut self.telemetry,
                        token,
                        CpuSegment::Shadow,
                        shadow_started,
                    );
                    finish(&mut self.telemetry, token, FrameResult::Failed);
                    return RenderOutcome::Failed(format!(
                        "native parallel shadow encode failed: {error}"
                    ));
                }
            }
            // 并行段时间戳已由 stamper 写进级联 CB;这里只翻活跃掩码。
            if let Some(telemetry) = self.telemetry.as_mut() {
                telemetry.gpu_mark_segment(GpuSegment::Shadow, true);
            }
            record(
                &mut self.telemetry,
                token,
                CpuSegment::Shadow,
                shadow_started,
            );
        } else {
            gpu_begin(&self.telemetry, GpuSegment::Shadow, &mut encoder);
            gpu_end(
                &mut self.telemetry,
                GpuSegment::Shadow,
                false,
                Some("shadow_cache_clean"),
                &mut encoder,
            );
            record(&mut self.telemetry, token, CpuSegment::Shadow, None);
        }

        gpu_begin(&self.telemetry, GpuSegment::Opaque, &mut encoder);
        let opaque = timer(token);
        // F2 pixel:opaque/MASK pass 的 RT 分支裁决抽成纯函数
        // `rt_residency::rt_opaque_ready`(行为与原 match 逐条一致):设备
        // ray query 驻留、RT frame 绑定、Ray Query 管线族、场景无 custom
        // shader 批次任一缺失都回退既有栅格路径,逐帧判定,fail-closed。
        // 回退条件由 rt_residency_tests(CPU)与 rt_fallback_gpu_tests
        // (真机)双向钉死。
        let rt_opaque = super::rt_residency::rt_opaque_ready(
            self.rt_residency.as_ref(),
            self.rt_frame_bind_group.as_ref(),
            self.scene.shader_materials.is_none(),
        );
        match rt_opaque {
            Some((pipelines, rt_bind_group)) => encode_opaque_pass_rt(
                &mut encoder,
                &self.forward_targets,
                rt_bind_group,
                &self.scene,
                &self.culling,
                self.lod.as_ref(),
                pipelines,
                self.hi_z.is_some() || self.scene.has_outline(),
            ),
            None => encode_opaque_pass(
                &mut encoder,
                &self.forward_targets,
                &self.frame_bind_group,
                &self.scene,
                &self.culling,
                self.lod.as_ref(),
                &self.pipelines,
                self.hi_z.is_some() || self.scene.has_outline(),
            ),
        }
        record(&mut self.telemetry, token, CpuSegment::Opaque, opaque);
        gpu_end(
            &mut self.telemetry,
            GpuSegment::Opaque,
            true,
            None,
            &mut encoder,
        );

        // R4 生产接线:HiZ 金字塔在 opaque 后立即生成(深度已完整;
        // transparent 深度不写入,不参与遮挡源)。遮挡判定 dispatch 在下一帧
        // SceneResources 段消费本帧金字塔——「消费上一帧」语义,与 TS
        // previousHiZVisibility 一致;首帧金字塔为远平面,保守不剔。
        let has_hiz = self.hi_z.is_some();
        gpu_begin(&self.telemetry, GpuSegment::HiZ, &mut encoder);
        let hi_z = timer(token).filter(|_| has_hiz);
        if let Some(pyramid) = &self.hi_z {
            pyramid.encode(&mut encoder);
        }
        record(&mut self.telemetry, token, CpuSegment::HiZ, hi_z);
        gpu_end(
            &mut self.telemetry,
            GpuSegment::HiZ,
            has_hiz,
            (!has_hiz).then_some("hiz_not_allocated"),
            &mut encoder,
        );

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
            (!has_transparent).then_some("no_transparent_geometry"),
            &mut encoder,
        );

        if self.scene.has_outline() {
            encode_outline_mask(
                &mut encoder,
                &self.forward_targets,
                &self.frame_bind_group,
                &self.scene,
                self.outline_mask_pipelines.raw(),
                &self.culling,
                self.lod.as_ref(),
            );
        }

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
        if self.scene.has_outline() {
            self.outline_pass.draw(&mut encoder, &view);
        }
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
            None,
            &mut encoder,
        );

        let has_deep2d = self.deep2d.is_some();
        gpu_begin(&self.telemetry, GpuSegment::Deep2d, &mut encoder);
        let deep2d = timer(token).filter(|_| has_deep2d);
        if let Some(painter) = &self.deep2d {
            #[cfg(windows)]
            painter.draw_with_dashboard_videos(
                &mut encoder,
                &view,
                (self.size.width, self.size.height),
                self.dashboard_video.as_ref(),
            );
            #[cfg(not(windows))]
            painter.draw(&mut encoder, &view, (self.size.width, self.size.height));
        }
        record(&mut self.telemetry, token, CpuSegment::Deep2d, deep2d);
        gpu_end(
            &mut self.telemetry,
            GpuSegment::Deep2d,
            has_deep2d,
            (!has_deep2d).then_some("no_deep2d_content"),
            &mut encoder,
        );

        super::frame_probes::encode_differential_probes(self, &mut encoder);
        if let (Some(telemetry), Some(token)) = (self.telemetry.as_mut(), token) {
            telemetry.gpu_finish_frame(token, &mut encoder);
        }
        let submit = timer(token);
        // 确定性提交:pre CB(culling/lod compute)→ 级联 CB(升序)→
        // 主 CB(opaque 起);单次 submit 内 FIFO 执行序,与串行布局一致。
        let submission = self.queue.submit(
            pre_encoder
                .map(wgpu::CommandEncoder::finish)
                .into_iter()
                .chain(shadow_buffers)
                .chain(std::iter::once(encoder.finish())),
        );
        if let Some(telemetry) = self.telemetry.as_mut() {
            telemetry.gpu_submitted_frame();
        }
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
        // R4 查准/查全校准钩子:候选 → drawn/culled 实例与非空批次 draw 数
        // (挂载时启用 readback 的如实观测;含每帧一次 map+poll 的诊断成本,
        // 属 opt-in 开关路径)。顺带刷新空批次跳过的计数快照;只观测,
        // 不做自动校准。
        match self.culling.take_occlusion_metrics(&self.device) {
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
    skip_reason: Option<&'static str>,
    encoder: &mut wgpu::CommandEncoder,
) {
    if let Some(telemetry) = telemetry {
        telemetry.gpu_end(segment, active, skip_reason, encoder);
    }
}
