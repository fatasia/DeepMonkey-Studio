use super::*;

impl MegaLightsGpuChain {
    /// 编码一帧:重建 → RIS 两趟(同 pass)→ 加性合成进 HDR(loadOp load)。
    /// 全部 GPU 驻留零读回;先于调用方 submit,本帧后段消费合成结果。
    pub(crate) fn encode_frame(
        &self,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        input: &MegaLightsGpuFrameInput<'_>,
    ) {
        let combined = combined_clip_to_view(input.view, input.frame_view_projection)
            .unwrap_or_else(|| world_to_view(input.view));
        queue.write_buffer(
            &self.rebuild_params,
            0,
            bytemuck::cast_slice(&pack_rebuild_params(&combined, self.width, self.height)),
        );
        queue.write_buffer(
            &self.composite_params,
            0,
            bytemuck::cast_slice(&pack_composite_params(self.width, self.height, input.exposure)),
        );
        let mut ris_words = pack_ris_params(self.width, self.height, input.light_count,
            input.frame_seed, true, true, input.exhaustive, input.alpha_blend);
        ris_words[9] = u32::from(self.inputs.is_some());
        queue.write_buffer(
            &self.ris_params,
            0,
            bytemuck::cast_slice(&ris_words),
        );
        queue.write_buffer(&self.lights, 0, bytemuck::cast_slice(input.packed_words));
        let ies_words: &[f32] = input.ies.unwrap_or(&IES_PLACEHOLDER_ROW);
        queue.write_buffer(&self.ies, 0, bytemuck::cast_slice(ies_words));
        let (groups_x, groups_y) = (self.width.div_ceil(8), self.height.div_ceil(8));
        if let Some(inputs) = &self.inputs {
            inputs.update(queue, input.view, input.frame_view_projection, self.width, self.height, input.light_count, input.shadow_mask);
            inputs.rebuild(encoder, self.width, self.height);
        } else {
            let mut rebuild = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("megalights surface rebuild"),
                ..Default::default()
            });
            rebuild.set_pipeline(&self.rebuild_pipeline);
            rebuild.set_bind_group(0, &self.rebuild_bind, &[]);
            rebuild.dispatch_workgroups(groups_x, groups_y, 1);
        }
        {
            let mut ris = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("megalights ris frame"),
                ..Default::default()
            });
            ris.set_pipeline(&self.build_pipeline);
            ris.set_bind_group(0, &self.build_bind, &[]);
            ris.dispatch_workgroups(groups_x, groups_y, 1);
        }
        if let Some(inputs) = &self.inputs { inputs.visibility(encoder, self.width, self.height); }
        {
            let mut ris = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("megalights RIS visible shade"), ..Default::default()
            });
            ris.set_pipeline(&self.shade_pipeline);
            ris.set_bind_group(0, &self.shade_bind, &[]);
            ris.dispatch_workgroups(groups_x, groups_y, 1);
        }
        if let Some(inputs)=&self.inputs {
            inputs.composite.encode(queue,encoder,self.full,(self.width,self.height),&combined,input.exposure,input.hdr_view,input.msaa_view);
            return;
        }
        let mut composite = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("megalights composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: input.msaa_view.unwrap_or(input.hdr_view),
                depth_slice: None,
                resolve_target: input.msaa_view.map(|_| input.hdr_view),
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            ..Default::default()
        });
        composite.set_pipeline(if input.msaa_view.is_some() { &self.composite_msaa_pipeline } else { &self.composite_pipeline });
        composite.set_bind_group(0, &self.composite_bind, &[]);
        deep_engine_native::benchmark_observer::note_draw();
        composite.draw(0..3, 0..1);
    }

    pub(crate) fn attach_inputs(&mut self, device: &wgpu::Device,
        gbuffer: &crate::renderer::megalights_gbuffer::MegaLightsGBuffer, depth: &wgpu::TextureView, tlas: &wgpu::Tlas) {
        self.inputs = Some(crate::renderer::megalights_inputs::MegaLightsInputs::create(device, gbuffer, depth,
            &self.surfaces, &self.reservoirs_a, &self.lights, &self.visibility, &self.color, tlas));
    }

    /// GPU-ordered uniform copies isolate RIS replacement to opaque draws.
    /// A queue.write_buffer between passes would affect the whole submission.
    pub(crate) fn local_lighting(&self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder,
        frame: &wgpu::Buffer, original_count: f32, restore: bool) {
        if !restore { queue.write_buffer(&self.local_count_switch, 0, bytemuck::cast_slice(&[-1.0f32, original_count])); }
        encoder.copy_buffer_to_buffer(&self.local_count_switch, if restore { 4 } else { 0 }, frame, 14 * 16 + 8, 4);
    }

    pub(crate) fn clear_history(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.clear_buffer(&self.reservoirs_a, 0, None); encoder.clear_buffer(&self.reservoirs_b, 0, None);
        encoder.clear_buffer(&self.color_history, 0, None);
    }

    /// 蓄水池/颜色/表面缓冲访问面(真机探针读回;生产代码不读回)。
    #[cfg(test)]
    pub(crate) fn probe_visibility(&self) -> &wgpu::Buffer { &self.visibility }
    #[cfg(test)]
    pub(crate) fn probe_buffers(&self) -> [&wgpu::Buffer; 5] {
        [&self.reservoirs_a, &self.reservoirs_b, &self.color, &self.color_history, &self.surfaces]
    }
}
