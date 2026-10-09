use super::*;

impl MegaLightsFrameRuntime {
    /// 本帧是否计划 GPU RIS 执行腿(决策 RIS 且未降级;调用方据此提前保留
    /// opaque 深度——重建核消费深度,depth store 不能 discard)。
    pub(crate) fn gpu_frame_planned(&self) -> bool {
        self.gate != MegaLightsGate::Off
            && self.decision.path == DirectLightingPath::MegalightsRis
            && self.execution_leg != MegaLightsExecutionLeg::GpuDegraded
    }

    /// 颜色 EMA 系数(首帧全量替换;TS 生产缺省 1/32 同款)。
    pub(super) fn gpu_alpha_blend(&self) -> f32 {
        if !self.history_valid { 1.0 } else { 1.0 / 32.0 }
    }

    /// Prepare the complete replacement before suppressing any clustered light.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare_gpu_frame(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        depth: &wgpu::TextureView,
        epoch: u64,
        frame_layout: &wgpu::BindGroupLayout,
        material_layout: &wgpu::BindGroupLayout,
        tlas: Option<&wgpu::Tlas>,
        supported_materials: bool,
    ) -> bool {
        if !self.gpu_frame_planned() {
            return false;
        }
        if self.packed.as_ref().is_none_or(|p| p.count == 0) {
            return false;
        }
        let reason = if !supported_materials {
            Some("native_megalights_material_profile_unsupported")
        } else if tlas.is_none() {
            Some("native_megalights_tlas_unavailable")
        } else {
            None
        };
        if let Some(reason) = reason {
            self.degrade(reason);
            return false;
        }
        let tlas = tlas.expect("checked TLAS");
        if !self.ensure_gpu_chain(
            device,
            depth,
            epoch,
            self.ies.as_ref().map(|(w, _)| w.len()),
        ) {
            return false;
        }
        let chain = self.gpu.as_mut().expect("prepared chain");
        let words = self.packed.as_ref().map_or(0, |p| p.data.len());
        let grew = !chain.lights_fit(words);
        let replace_gbuffer = self
            .gbuffer
            .as_ref()
            .is_none_or(|g| g.dimensions != self.pending_viewport || g.epoch != epoch);
        let replace_inputs = chain.inputs.as_ref().is_none_or(|i| i.tlas != *tlas);
        if !grew && !replace_gbuffer && !replace_inputs {
            return true;
        }
        let scopes = [
            device.push_error_scope(wgpu::ErrorFilter::Validation),
            device.push_error_scope(wgpu::ErrorFilter::OutOfMemory),
            device.push_error_scope(wgpu::ErrorFilter::Internal),
        ];
        if grew {
            chain.grow_lights(device, queue, words);
        }
        if replace_gbuffer {
            self.gbuffer = Some(
                crate::renderer::megalights_gbuffer::MegaLightsGBuffer::create(
                    device,
                    frame_layout,
                    material_layout,
                    self.pending_viewport.0,
                    self.pending_viewport.1,
                    epoch,
                ),
            );
        }
        if grew || replace_gbuffer || replace_inputs {
            chain.attach_inputs(device, self.gbuffer.as_ref().expect("GBuffer"), depth, tlas);
            self.history_valid = false;
        }
        let errors: Vec<_> = scopes
            .into_iter()
            .rev()
            .filter_map(|scope| pollster::block_on(scope.pop()))
            .collect();
        #[cfg(test)]
        for error in &errors {
            eprintln!("MegaLights actual inputs rejected: {error}");
        }
        let rejected = !errors.is_empty();
        if rejected {
            self.degrade("native_megalights_actual_inputs_device_rejected");
            return false;
        }
        true
    }

    fn degrade(&mut self, reason: &'static str) {
        self.gpu = None;
        self.gbuffer = None;
        self.history_valid = false;
        self.execution_leg = MegaLightsExecutionLeg::GpuDegraded;
        self.gpu_reject_reason = Some(reason);
    }

    /// GPU 执行腿帧段:懒挂载/换代重建 → 重建核 + RIS 两趟 + 加性合成。
    /// 返回是否真实 dispatch(降级/待命/无灯池 = false,视觉恒簇光)。
    /// error scope 走 pollster(resize 同款同步约定);任何挂载失败 =
    /// GpuDegraded sticky,后续帧不再尝试(诊断披露一次)。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn encode_gpu_frame(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        view: PlayerView,
        frame_view_projection: &[[f32; 4]; 4],
        depth_view: &wgpu::TextureView,
        depth_epoch: u64,
        hdr_view: &wgpu::TextureView,
        msaa_view: Option<&wgpu::TextureView>,
        exposure: f32,
    ) -> bool {
        if !self.gpu_frame_planned() {
            return false;
        }
        let ies_words = self.ies.as_ref().map(|(words, _)| words.len());
        if !self.ensure_gpu_chain(device, depth_view, depth_epoch, ies_words) {
            return false;
        }
        let words_needed = self.packed.as_ref().map_or(0, |packed| packed.data.len());
        if words_needed == 0 {
            return false;
        }
        if let Some(chain) = self.gpu.as_mut()
            && !chain.lights_fit(words_needed)
        {
            chain.grow_lights(device, queue, words_needed);
        }
        {
            let Some(chain) = self.gpu.as_ref() else {
                return false;
            };
            let Some(packed) = self.packed.as_ref() else {
                return false;
            };
            if !self.history_valid {
                chain.clear_history(encoder);
            }
            chain.encode_frame(
                queue,
                encoder,
                &crate::renderer::megalights_gpu::MegaLightsGpuFrameInput {
                    view,
                    frame_view_projection,
                    packed_words: &packed.data,
                    light_count: packed.count as u32,
                    shadow_mask: self.shadow_mask,
                    ies: self.ies.as_ref().map(|(words, _)| words.as_slice()),
                    frame_seed: self.frame_index,
                    alpha_blend: self.gpu_alpha_blend(),
                    exhaustive: false,
                    hdr_view,
                    msaa_view,
                    exposure,
                },
            );
        }
        self.gpu_dispatched_frames = self.gpu_dispatched_frames.wrapping_add(1);
        self.history_valid = true;
        true
    }

    /// GPU 链懒挂载/换代重建(error scope 三过滤;失败 sticky 降级)。
    fn ensure_gpu_chain(
        &mut self,
        device: &wgpu::Device,
        depth_view: &wgpu::TextureView,
        epoch: u64,
        ies_words: Option<usize>,
    ) -> bool {
        if let Some(chain) = &self.gpu
            && chain.matches(
                self.pending_viewport.0,
                self.pending_viewport.1,
                epoch,
                ies_words.unwrap_or(4),
            )
        {
            return true;
        }
        // 重建前拿视口:链已存在沿用其视口来源由调用方保证(前向目标换代 =
        // epoch 变,尺寸一并传入)。这里直接从现有链取,首挂载用调用方注入的
        // 当前前向尺寸(ensure 之前 frame.rs 已把 viewport 写进 runtime)。
        let (width, height) = self.pending_viewport;
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
        let chain = crate::renderer::megalights_gpu::MegaLightsGpuChain::create(
            device,
            depth_view,
            self.ies.as_ref().map(|(words, _)| words.as_slice()),
            width,
            height,
            epoch,
        );
        let errors = [
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
            pollster::block_on(validation.pop()),
        ];
        match (chain, errors.into_iter().flatten().next()) {
            (Ok(chain), None) => {
                self.gpu = Some(chain);
                self.execution_leg = MegaLightsExecutionLeg::GpuDispatchResident;
                self.gpu_reject_reason = None;
                self.history_valid = false;
                true
            }
            (chain, Some(_)) => {
                drop(chain);
                self.gpu = None;
                self.execution_leg = MegaLightsExecutionLeg::GpuDegraded;
                self.gpu_reject_reason = Some(
                    crate::renderer::megalights_gpu::MegaLightsGpuReject::DeviceRejected.reason(),
                );
                false
            }
            (Err(reject), None) => {
                self.gpu = None;
                self.execution_leg = MegaLightsExecutionLeg::GpuDegraded;
                self.gpu_reject_reason = Some(reject.reason());
                false
            }
        }
    }
}
