use bytemuck::cast_slice;
use deep_engine_native::deep2d::{
    Deep2dPathCache, Deep2dPathCacheStats, Deep2dRuntimeContent, PreparedDeep2d,
    PreparedDeep2dChunk, PreparedDeep2dChunkKind, PreparedDeep2dRuntimeSummary,
    prepare_runtime_content_cached,
};
use wgpu::util::DeviceExt;

use crate::{
    deep2d_atlas_gpu::Deep2dAtlasGpuResources,
    deep2d_gpu_cache::{CachedPathPipelines, Deep2dGpuAssetCache},
    deep2d_scissor::chunk_scissor,
};

const SHADER: &str = include_str!("../assets/shaders/native_deep2d_v1.wgsl");
#[path = "deep2d_vertex_transfer.rs"]
mod vertex_transfer;
pub use vertex_transfer::VertexTransferStats;
#[path = "deep2d_draw_evidence.rs"]
mod draw_evidence;
pub use draw_evidence::DrawEvidence;

struct Deep2dPathGpuResources {
    pipeline: std::sync::Arc<wgpu::RenderPipeline>,
    vertex_buffer: std::sync::Arc<wgpu::Buffer>,
    snapshot: Option<vertex_transfer::VertexSnapshot>,
    transfer: VertexTransferStats,
}

/// 宿主声明的帧级依赖上下文,喂给 `Deep2dPathCache` 的依赖图(P1-02)。
///
/// 两个维度都必须在 `prepare` 之前定格,原因见 `painter_cache::EntryWitness`:
/// - `resource_epoch` 承载内容来源代次(本包内 legend 页等呈现资源集换代;
///   换包走新建缓存,天然隔离);
/// - `camera_scale` 是**物理像素/逻辑单位**的实际缩放比,由 letterbox 映射算得,
///   直接决定描边容差与曲线细分密度。
///
/// 未提供上下文时缓存两侧维度保持 `None`,行为与第一批逐字节一致。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Deep2dFrameContext {
    pub resource_epoch: u64,
    pub camera_scale: f64,
}

/// 由内容与物理尺寸装配帧级上下文。
///
/// 缩放口径必须是「物理像素 / 逻辑单位」的实际比值,而不是窗口 DPI 标称值:
/// 二者只在逻辑尺寸等于物理尺寸时相同,非等比窗口下 letterbox 会取宽高比的
/// 最小值而缩小实际缩放。命中与绘制用的是同一个 `LetterboxMapping`,这里取
/// 同一映射的 `scale`,保证「见证 / 细分 / 命中」三者同源。
pub fn deep2d_frame_context(
    content: &Deep2dRuntimeContent,
    physical: [u32; 2],
    resource_epoch: u64,
) -> Deep2dFrameContext {
    let list = content.display_list();
    let logical = [list.logical_width, list.logical_height];
    let usable = physical[0] != 0
        && physical[1] != 0
        && logical[0].is_finite()
        && logical[1].is_finite()
        && logical[0] > 0.0
        && logical[1] > 0.0;
    let camera_scale = if usable {
        deep_engine_native::deep2d::LetterboxMapping::new(
            logical,
            [physical[0].into(), physical[1].into()],
        )
        .scale
    } else {
        // 退化窗口没有可用映射;显式声明 1:1 而不是留空,
        // 让「窗口从 0 尺寸恢复」也有确定性见证。
        1.0
    };
    Deep2dFrameContext {
        resource_epoch,
        camera_scale,
    }
}

use std::sync::Arc;

pub struct Deep2dGpuPainter {
    path: Option<Deep2dPathGpuResources>,
    atlas: Option<Deep2dAtlasGpuResources>,
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
        let mut path = (!prepared.path.vertices.is_empty()).then(|| {
            Deep2dPathGpuResources::new(
                device,
                queue,
                format,
                &frame_layout,
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
        let resources_ms = timing.elapsed().as_secs_f64() * 1000.0 - prepare_ms;
        let frame_bind_group = frame_resources(
            device,
            queue,
            &frame_layout,
            cache,
            [prepared.path.logical_width, prepared.path.logical_height],
        );
        if let Some(path) = &mut path {
            let byte_len = prepared.path.vertices.len() * 24;
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
            path,
            atlas,
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
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native Deep2d ordered pass v2"),
            color_attachments: &color_attachments,
            depth_stencil_attachment: None,
            ..Default::default()
        });
        let draw_chunk = |pass: &mut wgpu::RenderPass<'_>, chunk: &PreparedDeep2dChunk| {
            let Some(scissor) = chunk_scissor(chunk.clip_rect, self.logical_size, physical_size)
            else {
                return;
            };
            pass.set_scissor_rect(scissor[0], scissor[1], scissor[2], scissor[3]);
            pass.set_bind_group(0, &self.frame_resources.bind_group, &[]);
            match chunk.kind {
                PreparedDeep2dChunkKind::Path => {
                    let path = self.path.as_ref().expect("prepared path resource");
                    pass.set_pipeline(&path.pipeline);
                    pass.set_vertex_buffer(0, path.vertex_buffer.slice(..));
                }
                PreparedDeep2dChunkKind::Atlas { atlas_index } => {
                    let atlas = self.atlas.as_ref().expect("prepared atlas resource");
                    pass.set_pipeline(&atlas.pipeline);
                    pass.set_vertex_buffer(0, atlas.vertex_buffer.slice(..));
                    pass.set_bind_group(1, &atlas.atlases[atlas_index].bind_group, &[]);
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
    #[cfg(windows)]
    pub fn dashboard_video_slots(&self) -> &[DashboardVideoSlot] {
        &self.dashboard_video_slots
    }
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
    fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        frame_layout: &wgpu::BindGroupLayout,
        prepared: &PreparedDeep2d,
        cache: &Deep2dGpuAssetCache,
        previous: Option<&Self>,
    ) -> Self {
        let cached = cache.path_pipelines(format, || {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Deep Engine native Deep2d shader v1"),
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Deep Engine native Deep2d pipeline layout"),
                bind_group_layouts: &[Some(frame_layout)],
                immediate_size: 0,
            });
            let attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4];
            let buffers = [Some(wgpu::VertexBufferLayout {
                array_stride: 24,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &attributes,
            })];
            let targets = [Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })];
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Deep Engine native Deep2d alpha pipeline"),
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
            CachedPathPipelines {
                pipeline: Arc::new(pipeline),
            }
        });
        let pipeline = std::sync::Arc::clone(&cached.pipeline);
        let previous = previous.and_then(|p| {
            p.snapshot
                .as_ref()
                .map(|snapshot| (p.vertex_buffer.as_ref(), snapshot))
        });
        let (vertex_buffer, transfer) =
            vertex_transfer::upload(device, queue, prepared, cache, previous);
        Self {
            pipeline,
            vertex_buffer,
            snapshot: None,
            transfer,
        }
    }
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
