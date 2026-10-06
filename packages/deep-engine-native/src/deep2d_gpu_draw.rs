//! Deep2d 帧绘制编排(体量门拆分子模块;条目逐字未改):
//! 分层 chunk 组绘制、刀 3 stencil pass、刀 4 backdrop bracket(capture→
//! blur→底色 quad)与惰性模板附件。

use bytemuck::cast_slice;
use deep_engine_native::deep2d::{PreparedDeep2dChunk, PreparedDeep2dChunkKind};

use crate::deep2d_dynamic_gpu::{StencilTarget, pipeline_pair};
use crate::deep2d_scissor::chunk_scissor;

use super::DrawEvidence;

impl super::Deep2dGpuPainter {
    pub fn draw(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        physical_size: (u32, u32),
    ) {
        self.draw_internal(encoder, target, physical_size, None);
    }

    #[cfg(windows)]
    pub fn draw_with_dashboard_videos(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        physical_size: (u32, u32),
        videos: Option<&crate::dashboard_video_gpu::DashboardVideoGpuCompositor>,
    ) {
        self.draw_internal(encoder, target, physical_size, videos);
    }

    fn draw_internal(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        physical_size: (u32, u32),
        #[cfg(windows)] videos: Option<&crate::dashboard_video_gpu::DashboardVideoGpuCompositor>,
        #[cfg(not(windows))] _videos: Option<&()>,
    ) {
        self.draw_evidence.clear();
        #[cfg(windows)]
        let has_videos = videos.is_some_and(|videos| videos.max_layer_index().is_some());
        #[cfg(not(windows))]
        let has_videos = false;
        if self.chunks.is_empty() && !has_videos {
            return;
        }
        // The frame uniform carries the physical target size for aspect-fit;
        // identical consecutive sizes skip the re-upload (D06/D08).
        if self.last_physical_size.get() != Some(physical_size) {
            let frame = [[
                self.logical_size[0],
                self.logical_size[1],
                physical_size.0 as f32,
                physical_size.1 as f32,
            ]];
            self.queue
                .write_buffer(&self.frame_resources.buffer, 0, cast_slice(&frame));
            self.last_physical_size.set(Some(physical_size));
        }
        // 刀 3:动态块存在才附加模板附件并逐帧清零;纯静态帧的 pass 描述
        // 符与既有行为完全一致(不建纹理、不附加)。
        let has_dynamic = self
            .chunks
            .iter()
            .any(|chunk| matches!(chunk.kind, PreparedDeep2dChunkKind::DynamicPath { .. }));
        let with_stencil = has_dynamic;
        // 刀 4:backdrop 捕获链需要 COPY_SRC 源;目标不带该用法时如实跳过
        // backdrop 块(fail-safe:毛玻璃缺席,其余内容照常绘制)。
        let backdrop_enabled = self.backdrop.borrow().is_some()
            && target
                .texture()
                .usage()
                .contains(wgpu::TextureUsages::COPY_SRC);
        // 模板清零只发生在帧内第一个主 pass;backdrop bracket 重开 pass 时
        // Load 保持既有模板值。
        let mut clear_stencil = with_stencil;
        self.draw_chunk_group(
            encoder,
            target,
            physical_size,
            &self
                .chunks
                .iter()
                .filter(|chunk| chunk.layer_index.is_none())
                .collect::<Vec<_>>(),
            with_stencil,
            &mut clear_stencil,
            backdrop_enabled,
            #[cfg(windows)]
            None,
        );
        let max_deep2d_layer = self
            .chunks
            .iter()
            .filter_map(|chunk| chunk.layer_index)
            .max();
        #[cfg(windows)]
        let max_video_layer = videos.and_then(|videos| videos.max_layer_index());
        #[cfg(not(windows))]
        let max_video_layer = None;
        if let Some(max_layer) = max_deep2d_layer.into_iter().chain(max_video_layer).max() {
            for layer_index in 0..=max_layer {
                let chunks = &self
                    .chunks
                    .iter()
                    .filter(|chunk| chunk.layer_index == Some(layer_index))
                    .collect::<Vec<_>>();
                self.draw_chunk_group(
                    encoder,
                    target,
                    physical_size,
                    chunks,
                    with_stencil,
                    &mut clear_stencil,
                    backdrop_enabled,
                    #[cfg(windows)]
                    videos.map(|videos| (layer_index, videos)),
                );
            }
        }
    }

    /// 绘制一个层组的 chunk 序列(刀 4 bracket 化):遇到 Backdrop 块先
    /// 结束当前 pass,跑 capture→downsample→blur,再重开主 pass 画底色
    /// quad 并继续;无 backdrop 的帧与既有单 pass 行为逐字节一致。
    /// 组内最后一个主 pass 里追加宿主绘制(video 层)。
    #[allow(clippy::too_many_arguments)]
    fn draw_chunk_group<'a>(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        physical_size: (u32, u32),
        chunks: &[&'a PreparedDeep2dChunk],
        with_stencil: bool,
        clear_stencil: &mut bool,
        backdrop_enabled: bool,
        #[cfg(windows)] video: Option<(
            usize,
            &crate::dashboard_video_gpu::DashboardVideoGpuCompositor,
        )>,
    ) {
        if chunks.is_empty() {
            return;
        }
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })];
        let stencil_guard = self.stencil.borrow();
        // 显式生命周期:pass 借用 encoder,闭包签名必须让每次调用拿到
        // 独立的<'pass>生命周期(直接闭包会钉死到 'encoder)。
        fn begin_main_pass<'pass>(
            encoder: &'pass mut wgpu::CommandEncoder,
            color_attachments: &'pass [Option<wgpu::RenderPassColorAttachment<'pass>>],
            stencil_view: Option<&'pass wgpu::TextureView>,
            clear: bool,
        ) -> wgpu::RenderPass<'pass> {
            let depth_stencil_attachment = stencil_view.map(|view| {
                wgpu::RenderPassDepthStencilAttachment {
                    view,
                    depth_ops: None,
                    stencil_ops: Some(wgpu::Operations {
                        load: if clear {
                            wgpu::LoadOp::Clear(0)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: wgpu::StoreOp::Store,
                    }),
                }
            });
            encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Deep Engine native Deep2d ordered pass v2"),
                color_attachments,
                depth_stencil_attachment,
                ..Default::default()
            })
        }
        let stencil_view = with_stencil
            .then(|| stencil_guard.as_ref().map(|stencil| &stencil.view))
            .flatten();
        let draw_chunk = |pass: &mut wgpu::RenderPass<'_>, chunk: &PreparedDeep2dChunk| {
            let Some(scissor) = chunk_scissor(chunk.clip_rect, self.logical_size, physical_size)
            else {
                return;
            };
            pass.set_scissor_rect(scissor[0], scissor[1], scissor[2], scissor[3]);
            match chunk.kind {
                PreparedDeep2dChunkKind::Path => {
                    let path = self.path.as_ref().expect("prepared path resource");
                    // Path pipeline binds frame uniform + paint storage.
                    pass.set_bind_group(0, &path.bind_group, &[]);
                    let (pipeline, pipeline_stencil) =
                        path.pipeline_for(chunk.blend, with_stencil);
                    pass.set_pipeline(if with_stencil { pipeline_stencil } else { pipeline });
                    pass.set_vertex_buffer(0, path.vertex_buffer.slice(..));
                }
                PreparedDeep2dChunkKind::Backdrop { .. } => {
                    unreachable!("backdrop chunks are bracketed by the walk below")
                }
                PreparedDeep2dChunkKind::Atlas { atlas_index } => {
                    let atlas = self.atlas.as_ref().expect("prepared atlas resource");
                    pass.set_bind_group(0, &self.frame_resources.bind_group, &[]);
                    pass.set_pipeline(if with_stencil {
                        &atlas.pipeline_stencil
                    } else {
                        &atlas.pipeline
                    });
                    pass.set_vertex_buffer(0, atlas.vertex_buffer.slice(..));
                    pass.set_bind_group(1, &atlas.atlases[atlas_index].bind_group, &[]);
                }
                PreparedDeep2dChunkKind::DynamicPath {
                    edge_first,
                    edge_count,
                    fill_rule,
                } => {
                    // stencil-then-cover 三连:clear(bbox 模板归零)→
                    // cover(fence winding)→ fill(模板测试 + v2 着色)。
                    let path = self.path.as_ref().expect("prepared path resource");
                    let dynamic = self.dynamic.as_ref().expect("prepared dynamic resource");
                    let (cover_pipeline, fill_pipeline) =
                        pipeline_pair(&dynamic.pipelines, fill_rule);
                    pass.set_bind_group(0, &path.bind_group, &[]);
                    pass.set_pipeline(&dynamic.pipelines.clear);
                    pass.set_stencil_reference(0);
                    pass.set_vertex_buffer(0, path.vertex_buffer.slice(..));
                    pass.draw(chunk.first_vertex..chunk.first_vertex + chunk.vertex_count, 0..1);
                    pass.set_pipeline(cover_pipeline);
                    pass.set_bind_group(0, &dynamic.edge_bind_group, &[]);
                    pass.set_vertex_buffer(0, dynamic.edge_buffer.slice(..));
                    pass.draw(edge_first..edge_first + edge_count, 0..1);
                    pass.set_pipeline(fill_pipeline);
                    pass.set_bind_group(0, &path.bind_group, &[]);
                    // nonzero 比较 winding≠0(ref 0);evenodd 测 LSB==1
                    // (Invert 位翻转后的奇偶,read_mask 0x01)。
                    pass.set_stencil_reference(match fill_rule {
                        deep_engine_native::deep2d::FillRule::Nonzero => 0,
                        deep_engine_native::deep2d::FillRule::Evenodd => 1,
                    });
                    pass.set_vertex_buffer(0, path.vertex_buffer.slice(..));
                    pass.draw(chunk.first_vertex..chunk.first_vertex + chunk.vertex_count, 0..1);
                    // 动态块自管绘制(clear/cover/fill),不走 match 后的尾随
                    // draw——否则 fill 会以当前管线再执行一次(实测二次混合)。
                    self.draw_evidence.record(chunk);
                    return;
                }
            }
            pass.draw(
                chunk.first_vertex..chunk.first_vertex + chunk.vertex_count,
                0..1,
            );
            self.draw_evidence.record(chunk);
        };
        // 分段执行:每段连续普通块共用一个 pass;Backdrop 块打断 pass
        // (capture→blur→底色 quv 各自独立 pass 作用域),encoder 借用因此
        // 逐段顺序获取,无重叠。
        enum PlanItem<'b> {
            Draw(&'b PreparedDeep2dChunk),
            Bracket(usize),
        }
        let plan: Vec<PlanItem> = chunks
            .iter()
            .map(|chunk| match chunk.kind {
                PreparedDeep2dChunkKind::Backdrop { index } => PlanItem::Bracket(index),
                _ => PlanItem::Draw(chunk),
            })
            .collect();
        let mut cursor = 0usize;
        while cursor < plan.len() {
            let run_start = cursor;
            while cursor < plan.len() && matches!(plan[cursor], PlanItem::Draw(_)) {
                cursor += 1;
            }
            let final_run = cursor == plan.len();
            if cursor > run_start || final_run {
                let mut pass = begin_main_pass(
                    encoder,
                    &color_attachments,
                    stencil_view,
                    std::mem::take(clear_stencil),
                );
                for item in &plan[run_start..cursor] {
                    let PlanItem::Draw(chunk) = item else {
                        unreachable!("run holds only Draw items")
                    };
                    draw_chunk(&mut pass, chunk);
                }
                if final_run {
                    #[cfg(windows)]
                    if let Some((layer_index, videos)) = video {
                        videos.draw_layer(&mut pass, layer_index, physical_size);
                    }
                }
                drop(pass);
            }
            if cursor < plan.len() {
                let PlanItem::Bracket(index) = plan[cursor] else {
                    unreachable!("segment boundary is a bracket")
                };
                cursor += 1;
                if backdrop_enabled {
                    let chunk = chunks
                        .iter()
                        .find(|chunk| matches!(chunk.kind, PreparedDeep2dChunkKind::Backdrop { index: candidate } if candidate == index))
                        .expect("bracket chunk present");
                    let chunk_params = self
                        .backdrop_chunks
                        .get(index)
                        .expect("backdrop chunk index in range");
                    let base = {
                        let mut backdrop = self.backdrop.borrow_mut();
                        let backdrop = backdrop.as_mut().expect("backdrop resources");
                        backdrop.capture_and_blur(
                            encoder,
                            target,
                            physical_size,
                            chunk_params,
                            self.logical_size,
                        )
                    };
                    let mut pass = begin_main_pass(
                        encoder,
                        &color_attachments,
                        stencil_view,
                        std::mem::take(clear_stencil),
                    );
                    if let Some(scissor) =
                        chunk_scissor(chunk.clip_rect, self.logical_size, physical_size)
                    {
                        pass.set_scissor_rect(scissor[0], scissor[1], scissor[2], scissor[3]);
                    }
                    let backdrop = self.backdrop.borrow();
                    backdrop
                        .as_ref()
                        .expect("backdrop resources")
                        .draw_base(&mut pass, &base, with_stencil);
                    drop(pass);
                    self.draw_evidence.record(chunk);
                }
            }
        }
        #[cfg(not(windows))]
        let _ = video;
    }

    pub fn draw_evidence(&self) -> Vec<DrawEvidence> {
        self.draw_evidence.snapshot()
    }

    /// 按物理尺寸惰性取模板附件;尺寸变更重建(与 frame uniform 的
    /// `last_physical_size` 同样的懒策略,动态块缺席的帧从不创建)。
    fn stencil_view(&self, physical_size: (u32, u32)) -> StencilTarget {
        let mut guard = self.stencil.borrow_mut();
        if let Some(stencil) = guard.as_ref()
            && stencil.size == physical_size
        {
            return StencilTarget {
                size: stencil.size,
                view: stencil.view.clone(),
            };
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native Deep2d dynamic stencil"),
            size: wgpu::Extent3d {
                width: physical_size.0,
                height: physical_size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Stencil8,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let target = StencilTarget {
            size: physical_size,
            view: view.clone(),
        };
        *guard = Some(StencilTarget {
            size: physical_size,
            view,
        });
        target
    }
    pub fn atlas_inventory(&self) -> &[serde_json::Value] {
        self.draw_evidence.atlas_inventory()
    }
    pub fn enable_draw_evidence(&self) {
        self.draw_evidence.enable();
    }
}
