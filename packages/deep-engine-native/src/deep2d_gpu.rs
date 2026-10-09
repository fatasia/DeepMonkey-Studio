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
pub use crate::deep2d_frame_context::Deep2dFrameContext;
#[path = "deep2d_vertex_transfer.rs"]
mod vertex_transfer;
pub use vertex_transfer::VertexTransferStats;
#[path = "deep2d_draw_evidence.rs"]
mod draw_evidence;
pub use draw_evidence::DrawEvidence;
#[path = "deep2d_gpu_blend.rs"]
mod blend_family;
#[path = "deep2d_gpu_frame.rs"]
mod frame_setup;
pub(crate) use frame_setup::path_paint_layout;
use frame_setup::{frame_layout, frame_resources};
#[cfg(windows)]
#[path = "deep2d_gpu_video_slot.rs"]
mod video_slot;
#[cfg(windows)]
pub use video_slot::DashboardVideoSlot;
#[cfg(windows)]
use video_slot::dashboard_video_slots;

struct Deep2dPathGpuResources {
    /// 刀 4:blend 管线族(按 `DEEP2D_BLEND_*` 索引;.0 无模板/.1 Stencil8
    /// no-op 变体;索引 0 = normal,与 legacy 主管线同参同对象)。
    blend_families: [(
        std::sync::Arc<wgpu::RenderPipeline>,
        std::sync::Arc<wgpu::RenderPipeline>,
    ); 6],
    /// Path bind group: frame uniform (binding 0) + paint storage (binding 1).
    bind_group: wgpu::BindGroup,
    vertex_buffer: std::sync::Arc<wgpu::Buffer>,
    snapshot: Option<vertex_transfer::VertexSnapshot>,
    transfer: VertexTransferStats,
}

impl Deep2dPathGpuResources {
    /// 刀 4:按块选管线族;未知模式 fail-closed 回落 normal。
    fn pipeline_for(&self, blend: u32, with_stencil: bool) -> &wgpu::RenderPipeline {
        let (plain, stencil) = if blend < 6 {
            &self.blend_families[blend as usize]
        } else {
            &self.blend_families[0]
        };
        if with_stencil { stencil } else { plain }
    }
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
    /// 刀 4:毛玻璃捕获链资源(无 backdrop 块的帧不创建,零开销)。
    /// RefCell 与 stencil 同策略:pass 绘制闭包内需要 `&mut` 跑捕获链。
    backdrop: std::cell::RefCell<Option<crate::deep2d_backdrop_gpu::Deep2dBackdropGpuResources>>,
    /// 刀 4:backdrop 块参数,`Backdrop { index }` 指本表。
    backdrop_chunks: Vec<deep_engine_native::deep2d::PreparedBackdropChunk>,
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
            backdrop: std::cell::RefCell::new((!prepared.path.backdrop_chunks.is_empty()).then(
                || crate::deep2d_backdrop_gpu::Deep2dBackdropGpuResources::new(device, format),
            )),
            backdrop_chunks: std::mem::take(&mut prepared.path.backdrop_chunks),
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
        let depth_stencil_attachment =
            stencil_guard
                .as_ref()
                .map(|stencil| wgpu::RenderPassDepthStencilAttachment {
                    view: &stencil.view,
                    depth_ops: None,
                    stencil_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(0),
                        store: wgpu::StoreOp::Store,
                    }),
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
                    // 刀 4:按块选 blend 管线族(normal 与 legacy 同对象)。
                    pass.set_bind_group(0, &path.bind_group, &[]);
                    pass.set_pipeline(path.pipeline_for(chunk.blend, with_stencil));
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
                    deep_engine_native::benchmark_observer::note_draw();
                    pass.draw(
                        chunk.first_vertex..chunk.first_vertex + chunk.vertex_count,
                        0..1,
                    );
                    pass.set_pipeline(cover_pipeline);
                    pass.set_bind_group(0, &dynamic.edge_bind_group, &[]);
                    pass.set_vertex_buffer(0, dynamic.edge_buffer.slice(..));
                    deep_engine_native::benchmark_observer::note_draw();
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
                    deep_engine_native::benchmark_observer::note_draw();
                    pass.draw(
                        chunk.first_vertex..chunk.first_vertex + chunk.vertex_count,
                        0..1,
                    );
                    // 动态块自管绘制(clear/cover/fill),不走 match 后的尾随
                    // draw——否则 fill 会以当前管线再执行一次(实测二次混合)。
                    self.draw_evidence.record(chunk);
                    return;
                }
                PreparedDeep2dChunkKind::Backdrop { .. } => {
                    // 刀 4 毛玻璃 bracket:块不携带主 pass 顶点(枚举约定
                    // first_vertex/vertex_count 不用),capture→blur→底色
                    // quad 由 backdrop 专用管线按绘制序负责,主 pass 跳过。
                    return;
                }
            }
            deep_engine_native::benchmark_observer::note_draw();
            pass.draw(
                chunk.first_vertex..chunk.first_vertex + chunk.vertex_count,
                0..1,
            );
            self.draw_evidence.record(chunk);
        };
        // 刀 4:backdrop 块在绘制序内强制 bracket——结束主 pass,对 target
        // 跑捕获链(copy→下采样→可分离扫),再以完全一致的附件重开 pass 画
        // 底色 quad;后续块(含视频层)在重开的 pass 上续画。
        macro_rules! draw_chunk_ordered {
            ($pass:ident, $chunk:expr) => {{
                let chunk = $chunk;
                if matches!(chunk.kind, PreparedDeep2dChunkKind::Backdrop { .. }) {
                    drop($pass);
                    $pass = self.backdrop_bracket(
                        encoder,
                        target,
                        physical_size,
                        chunk,
                        with_stencil,
                        stencil_guard.as_ref().map(|stencil| &stencil.view),
                    );
                } else {
                    draw_chunk(&mut $pass, chunk);
                }
            }};
        }
        for chunk in self
            .chunks
            .iter()
            .filter(|chunk| chunk.layer_index.is_none())
        {
            draw_chunk_ordered!(pass, chunk);
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
                    draw_chunk_ordered!(pass, chunk);
                }
                #[cfg(windows)]
                if let Some(videos) = videos {
                    videos.draw_layer(&mut pass, layer_index, physical_size);
                }
            }
        }
    }

    /// 刀 4 backdrop bracket:跑捕获链并以与主 pass 一致的附件重开 pass,
    /// 画底色 quad;返回重开后的 pass 供后续块续画(附件/负载语义同主 pass:
    /// color Load::Load,动态块存在时 stencil Clear(0) 与每块自 bracket 对齐)。
    #[allow(clippy::too_many_arguments)]
    fn backdrop_bracket<'pass>(
        &self,
        encoder: &'pass mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        physical_size: (u32, u32),
        chunk: &PreparedDeep2dChunk,
        with_stencil: bool,
        stencil: Option<&wgpu::TextureView>,
    ) -> wgpu::RenderPass<'pass> {
        let PreparedDeep2dChunkKind::Backdrop { index } = chunk.kind else {
            unreachable!("backdrop bracket scheduled for a non-backdrop chunk");
        };
        let spec = &self.backdrop_chunks[index];
        let base = {
            let mut resources = self.backdrop.borrow_mut();
            resources
                .as_mut()
                .expect("backdrop resources exist with backdrop chunks")
                .capture_and_blur(encoder, target, physical_size, spec, self.logical_size)
        };
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })];
        let depth_stencil_attachment = stencil.map(|view| wgpu::RenderPassDepthStencilAttachment {
            view,
            depth_ops: None,
            stencil_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(0),
                store: wgpu::StoreOp::Store,
            }),
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native Deep2d ordered pass v2 (backdrop bracket)"),
            color_attachments: &color_attachments,
            depth_stencil_attachment,
            ..Default::default()
        });
        if let Some(scissor) = chunk_scissor(chunk.clip_rect, self.logical_size, physical_size) {
            pass.set_scissor_rect(scissor[0], scissor[1], scissor[2], scissor[3]);
        }
        self.backdrop
            .borrow()
            .as_ref()
            .expect("backdrop resources exist with backdrop chunks")
            .draw_base(&mut pass, &base, with_stencil);
        pass
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
                blend_families: blend_family::blend_family(device, &pipeline_layout, &shader, format),
            }
        });
        // 刀 4:族索引 0 用主管线同对象,保证 normal 帧与 legacy 逐字节一致。
        let mut blend_families = cached.blend_families.clone();
        blend_families[0] = (
            Arc::clone(&cached.pipeline),
            Arc::clone(&cached.pipeline_stencil),
        );
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
            blend_families,
            bind_group,
            vertex_buffer,
            snapshot: None,
            transfer,
        }
    }
}
