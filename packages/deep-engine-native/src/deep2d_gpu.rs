use bytemuck::cast_slice;
use deep_engine_native::deep2d::{
    Deep2dPathCache, Deep2dPathCacheStats, Deep2dRuntimeContent, PreparedDeep2d,
    PreparedDeep2dChunk, PreparedDeep2dChunkKind, PreparedDeep2dRuntimeSummary,
    prepare_runtime_content_cached,
};
use wgpu::util::DeviceExt;

use crate::{
    deep2d_atlas_gpu::Deep2dAtlasGpuResources,
    deep2d_dynamic_gpu::{Deep2dDynamicPathGpuResources, StencilTarget, pipeline_pair},
    deep2d_gpu_cache::{CachedPathPipelines, Deep2dGpuAssetCache},
    deep2d_scissor::chunk_scissor,
};

const SHADER: &str = include_str!("../assets/shaders/native_deep2d_v1.wgsl");

// 宿主入口保持原路径:app/deep2d_context.rs 从本模块导入帧上下文。
pub use crate::deep2d_frame_context::{Deep2dFrameContext, deep2d_frame_context};
#[path = "deep2d_vertex_transfer.rs"]
mod vertex_transfer;
pub use vertex_transfer::VertexTransferStats;
#[path = "deep2d_draw_evidence.rs"]
mod draw_evidence;
pub use draw_evidence::DrawEvidence;

struct Deep2dPathGpuResources {
    pipeline: std::sync::Arc<wgpu::RenderPipeline>,
    /// 刀 3:含模板附件 pass 用的 no-op stencil 变体(与主管线同 shader/
    /// 布局/混合,仅 depth_stencil 声明 Stencil8)。
    pipeline_stencil: std::sync::Arc<wgpu::RenderPipeline>,
    /// Path bind group: frame uniform (binding 0) + paint storage (binding 1).
    bind_group: wgpu::BindGroup,
    vertex_buffer: std::sync::Arc<wgpu::Buffer>,
    snapshot: Option<vertex_transfer::VertexSnapshot>,
    transfer: VertexTransferStats,
}

use std::sync::Arc;

pub struct Deep2dGpuPainter {
    device: wgpu::Device,
    path: Option<Deep2dPathGpuResources>,
    atlas: Option<Deep2dAtlasGpuResources>,
    /// 刀 3:动态路径 stencil 资源(动态块缺席时为 None,零开销)。
    dynamic: Option<Deep2dDynamicPathGpuResources>,
    /// 刀 3:按物理尺寸惰性创建的模板附件(动态块缺席的帧不附加)。
    stencil: std::cell::RefCell<Option<StencilTarget>>,
    cache: Arc<Deep2dGpuAssetCache>,
    path_cache: Arc<std::sync::Mutex<Deep2dPathCache>>,
    queue: Arc<wgpu::Queue>,
    frame_resources: std::sync::Arc<crate::deep2d_gpu_cache::FrameResources>,
    chunks: Vec<PreparedDeep2dChunk>,
    draw_evidence: draw_evidence::DrawEvidenceTracker,
    logical_size: [f32; 2],
    #[cfg(windows)]
    dashboard_video_slots: Vec<DashboardVideoSlot>,
    /// Physical size last written into the frame uniform; equal sizes skip
    /// the re-upload (D06/D08).
    last_physical_size: std::cell::Cell<Option<(u32, u32)>>,
    pub summary: PreparedDeep2dRuntimeSummary,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq)]
pub struct DashboardVideoSlot {
    pub node_id: String,
    pub layer_index: usize,
    pub frame: [f32; 4],
    pub clip: deep_engine_native::deep2d::Deep2dRect,
}

impl Deep2dGpuPainter {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        content: &Deep2dRuntimeContent,
        cache: &std::sync::Arc<Deep2dGpuAssetCache>,
    ) -> Result<Self, String> {
        Self::new_candidate(device, queue, format, content, cache, None, None)
    }

    /// 宿主装配入口:显式声明帧级依赖(epoch/相机物理缩放)后再准备内容。
    pub fn new_with_context(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        content: &Deep2dRuntimeContent,
        cache: &std::sync::Arc<Deep2dGpuAssetCache>,
        context: Deep2dFrameContext,
    ) -> Result<Self, String> {
        Self::new_candidate(device, queue, format, content, cache, None, Some(context))
    }

    fn new_candidate(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        content: &Deep2dRuntimeContent,
        cache: &Arc<Deep2dGpuAssetCache>,
        previous: Option<&Self>,
        context: Option<Deep2dFrameContext>,
    ) -> Result<Self, String> {
        let timing = web_time::Instant::now();
        #[cfg(windows)]
        let dashboard_video_slots = dashboard_video_slots(content)?;
        let path_cache = previous.map(|p| p.path_cache.clone()).unwrap_or_else(|| {
            Arc::new(std::sync::Mutex::new(Deep2dPathCache::with_package_cache()))
        });
        let mut prepared = {
            let mut cache = path_cache
                .lock()
                .map_err(|_| "Deep2d path cache lock failed")?;
            // 帧级维度必须在任何条目比较之前声明:声明后见证与细分缩放同源,
            // 旧代条目在下一次 prepare 按依赖图失效并归因。
            if let Some(context) = context {
                cache.set_resource_epoch(context.resource_epoch);
                cache.set_camera_scale(context.camera_scale);
            }
            prepare_runtime_content_cached(content, &mut cache)?
        };
        let prepare_ms = timing.elapsed().as_secs_f64() * 1000.0;
        let frame_layout = cache.frame_layout(|| frame_layout(device));
        // Frame uniform first: the path bind group composes it with the paint
        // storage buffer.
        let frame_bind_group = frame_resources(
            device,
            queue,
            &frame_layout,
            cache,
            [prepared.path.logical_width, prepared.path.logical_height],
        );
        let mut path = (!prepared.path.vertices.is_empty()).then(|| {
            Deep2dPathGpuResources::new(
                device,
                queue,
                format,
                &frame_bind_group.buffer,
                &prepared.path,
                cache,
                previous.and_then(|p| p.path.as_ref()),
            )
        });
        let atlas = (!prepared.atlas_vertices.is_empty())
            .then(|| {
                Deep2dAtlasGpuResources::new(device, queue, format, &frame_layout, &prepared, cache)
            })
            .transpose()?;
        let dynamic = (!prepared.path.dynamic_edges.is_empty()).then(|| {
            Deep2dDynamicPathGpuResources::new(
                device,
                &frame_layout,
                &frame_bind_group.buffer,
                &prepared.path,
                format,
                cache,
            )
        });
        let resources_ms = timing.elapsed().as_secs_f64() * 1000.0 - prepare_ms;
        if let Some(path) = &mut path {
            let byte_len = prepared.path.vertices.len() * vertex_transfer::STRIDE;
            path.snapshot = vertex_transfer::VertexSnapshot::capture(&mut prepared.path);
            path.transfer.shadow_bytes = if path.snapshot.is_some() { byte_len } else { 0 };
        }
        let draw_evidence = draw_evidence::DrawEvidenceTracker::new(content, &prepared.atlases);
        if std::env::var_os("DEEP_DASHBOARD_FILTER_EVIDENCE").is_some() {
            println!(
                "dashboard GPU prepare_ms={prepare_ms:.3} resources_ms={resources_ms:.3} evidence_ms={:.3}",
                timing.elapsed().as_secs_f64() * 1000.0 - prepare_ms - resources_ms
            );
        }
        Ok(Self {
            device: device.clone(),
            path,
            atlas,
            dynamic,
            stencil: std::cell::RefCell::new(None),
            cache: Arc::clone(cache),
            path_cache,
            queue: Arc::new(queue.clone()),
            frame_resources: frame_bind_group,
            draw_evidence,
            chunks: prepared.chunks,
            logical_size: [prepared.path.logical_width, prepared.path.logical_height],
            #[cfg(windows)]
            dashboard_video_slots,
            last_physical_size: std::cell::Cell::new(None),
            summary: prepared.summary,
        })
    }

    /// Stages replacement resources against this device-epoch cache. The active
    /// painter stays intact until the returned candidate is published.
    pub fn stage_update(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        content: &Deep2dRuntimeContent,
    ) -> Result<Self, String> {
        Self::new_candidate(
            device,
            queue,
            format,
            content,
            &self.cache,
            Some(self),
            None,
        )
    }

    /// 宿主换包/换页入口:与 `stage_update` 相同的事务语义,但显式声明帧级依赖,
    /// 使旧代条目按依赖图失效(epoch/相机)而不是被误判为命中。
    pub fn stage_update_with_context(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        content: &Deep2dRuntimeContent,
        context: Deep2dFrameContext,
    ) -> Result<Self, String> {
        Self::new_candidate(
            device,
            queue,
            format,
            content,
            &self.cache,
            Some(self),
            Some(context),
        )
    }

    pub fn vertex_transfer_stats(&self) -> VertexTransferStats {
        self.path
            .as_ref()
            .map_or_else(Default::default, |path| path.transfer)
    }

    pub fn path_cache_stats(&self) -> Deep2dPathCacheStats {
        self.path_cache
            .lock()
            .map(|cache| cache.stats())
            .unwrap_or_default()
    }

    pub fn cache_stats(&self) -> crate::deep2d_gpu_cache::Deep2dCacheStats {
        self.cache.stats()
    }

    /// Test access to the cached frame resources for pointer-identity checks.
    #[cfg(test)]
    pub fn frame_resources_test(&self) -> &std::sync::Arc<crate::deep2d_gpu_cache::FrameResources> {
        &self.frame_resources
    }

    /// Test/observability access to a resident atlas texture handle.
    #[cfg(test)]
    pub fn resident_atlas(
        &self,
        index: usize,
    ) -> Option<&std::sync::Arc<crate::deep2d_atlas_gpu::ResidentAtlas>> {
        self.atlas.as_ref()?.atlases.get(index)
    }

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
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })];
        // 刀 3:动态块存在才附加模板附件并逐帧清零;纯静态帧的 pass 描述
        // 符与既有行为完全一致(不建纹理、不附加)。
        let has_dynamic = self
            .chunks
            .iter()
            .any(|chunk| matches!(chunk.kind, PreparedDeep2dChunkKind::DynamicPath { .. }));
        let stencil_guard = has_dynamic.then(|| self.stencil_view(physical_size));
        let depth_stencil_attachment = stencil_guard.as_ref().map(|stencil| {
            wgpu::RenderPassDepthStencilAttachment {
                view: &stencil.view,
                depth_ops: None,
                stencil_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(0),
                    store: wgpu::StoreOp::Store,
                }),
            }
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native Deep2d ordered pass v2"),
            color_attachments: &color_attachments,
            depth_stencil_attachment,
            ..Default::default()
        });
        // 模板附件存在时,pass 内全部管线必须声明 Stencil8:静态 path/atlas
        // 用 no-op 变体,动态块用三连管线。
        let with_stencil = has_dynamic;
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
                    pass.set_pipeline(if with_stencil {
                        &path.pipeline_stencil
                    } else {
                        &path.pipeline
                    });
                    pass.set_vertex_buffer(0, path.vertex_buffer.slice(..));
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
        for chunk in self
            .chunks
            .iter()
            .filter(|chunk| chunk.layer_index.is_none())
        {
            draw_chunk(&mut pass, chunk);
        }
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
                for chunk in self
                    .chunks
                    .iter()
                    .filter(|chunk| chunk.layer_index == Some(layer_index))
                {
                    draw_chunk(&mut pass, chunk);
                }
                #[cfg(windows)]
                if let Some(videos) = videos {
                    videos.draw_layer(&mut pass, layer_index, physical_size);
                }
            }
        }
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
    #[cfg(windows)]
    pub fn dashboard_video_slots(&self) -> &[DashboardVideoSlot] {
        &self.dashboard_video_slots
    }
    #[cfg(windows)]
    pub fn logical_size(&self) -> [f32; 2] {
        self.logical_size
    }
    pub fn atlas_inventory(&self) -> &[serde_json::Value] {
        self.draw_evidence.atlas_inventory()
    }
    pub fn enable_draw_evidence(&self) {
        self.draw_evidence.enable();
    }
}

#[cfg(windows)]
fn dashboard_video_slots(
    content: &Deep2dRuntimeContent,
) -> Result<Vec<DashboardVideoSlot>, String> {
    let Deep2dRuntimeContent::Composite(composite) = content else {
        return Ok(Vec::new());
    };
    composite
        .layers()
        .iter()
        .enumerate()
        .filter_map(|(layer_index, layer)| {
            layer.id.strip_suffix(":video").map(|node_id| {
                let list = layer.content.display_list();
                let values = [
                    layer.translation[0],
                    layer.translation[1],
                    list.logical_width,
                    list.logical_height,
                ];
                if values.iter().any(|value| !value.is_finite())
                    || values[2] <= 0.0
                    || values[3] <= 0.0
                {
                    return Err("invalid dashboard video slot geometry".into());
                }
                Ok(DashboardVideoSlot {
                    node_id: node_id.to_owned(),
                    layer_index,
                    frame: values.map(|value| value as f32),
                    clip: layer.clip,
                })
            })
        })
        .collect()
}

impl Deep2dPathGpuResources {
    #[allow(clippy::too_many_arguments)]
    fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        frame_buffer: &wgpu::Buffer,
        prepared: &PreparedDeep2d,
        cache: &Deep2dGpuAssetCache,
        previous: Option<&Self>,
    ) -> Self {
        let paints_layout = cache.path_paint_layout(|| path_paint_layout(device));
        let cached = cache.path_pipelines(format, || {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Deep Engine native Deep2d shader v2"),
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Deep Engine native Deep2d pipeline layout"),
                bind_group_layouts: &[Some(paints_layout.as_ref())],
                immediate_size: 0,
            });
            let attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4, 2 => Float32x2, 3 => Float32];
            let buffers = [Some(wgpu::VertexBufferLayout {
                array_stride: 36,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &attributes,
            })];
            let targets = [Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })];
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Deep Engine native Deep2d alpha pipeline v2"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &buffers,
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fragment_main"),
                    compilation_options: Default::default(),
                    targets: &targets,
                }),
                multiview_mask: None,
                cache: None,
            });
            let pipeline_stencil = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Deep Engine native Deep2d alpha pipeline v2 (stencil pass variant)"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &buffers,
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Stencil8,
                    depth_write_enabled: Some(false),
                    depth_compare: Some(wgpu::CompareFunction::Always),
                    stencil: crate::deep2d_dynamic_gpu::no_op_stencil(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fragment_main"),
                    compilation_options: Default::default(),
                    targets: &targets,
                }),
                multiview_mask: None,
                cache: None,
            });
            CachedPathPipelines {
                pipeline: Arc::new(pipeline),
                pipeline_stencil: Arc::new(pipeline_stencil),
            }
        });
        let pipeline = std::sync::Arc::clone(&cached.pipeline);
        let pipeline_stencil = std::sync::Arc::clone(&cached.pipeline_stencil);
        let previous = previous.and_then(|p| {
            p.snapshot
                .as_ref()
                .map(|snapshot| (p.vertex_buffer.as_ref(), snapshot))
        });
        let (vertex_buffer, transfer) =
            vertex_transfer::upload(device, queue, prepared, cache, previous);
        // Paint storage: slot 0 is always present (reserved solid dummy), so
        // the buffer is never empty; gradients/quads read it per fragment.
        let paints_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native Deep2d paints"),
            contents: bytemuck::cast_slice(&prepared.paints),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native Deep2d paint bindings"),
            layout: &paints_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: frame_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: paints_buffer.as_entire_binding(),
                },
            ],
        });
        Self {
            pipeline,
            pipeline_stencil,
            bind_group,
            vertex_buffer,
            snapshot: None,
            transfer,
        }
    }
}

/// Path-stage bind group layout: frame uniform (vertex) + paint storage
/// (fragment). Separate from the shared atlas frame layout so the atlas
/// pipeline never pays for the storage binding. 刀 3 动态 clear/fill 管线
/// 复用同一布局以共享 bind group。
pub(crate) fn path_paint_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native Deep2d paint layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    })
}

fn frame_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native Deep2d frame layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    })
}

/// Cached frame uniform buffer + bind group per logical size. The physical
/// size half of the uniform is written per draw; the initial upload assumes
/// a square-uniform mapping so a first frame without any draw still binds.
fn frame_resources(
    device: &wgpu::Device,
    _queue: &wgpu::Queue,
    layout: &wgpu::BindGroupLayout,
    cache: &Deep2dGpuAssetCache,
    logical_size: [f32; 2],
) -> std::sync::Arc<crate::deep2d_gpu_cache::FrameResources> {
    if let Some(resources) = cache.frame_resources(logical_size[0], logical_size[1]) {
        return resources;
    }
    let frame = [[
        logical_size[0],
        logical_size[1],
        logical_size[0],
        logical_size[1],
    ]];
    let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Deep Engine native Deep2d frame"),
        contents: cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Deep Engine native Deep2d frame bindings"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    });
    cache.store_frame_resources(
        logical_size[0],
        logical_size[1],
        crate::deep2d_gpu_cache::FrameResources { buffer, bind_group },
    )
}
