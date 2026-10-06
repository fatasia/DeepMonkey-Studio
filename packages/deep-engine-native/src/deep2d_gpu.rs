use bytemuck::cast_slice;
use deep_engine_native::deep2d::{
    Deep2dPathCache, Deep2dPathCacheStats, Deep2dRuntimeContent, PreparedDeep2dChunk,
    PreparedDeep2dRuntimeSummary, prepare_runtime_content_cached,
};
use wgpu::util::DeviceExt;

use deep_engine_native::deep2d::PreparedBackdropChunk;

use crate::{
    deep2d_atlas_gpu::Deep2dAtlasGpuResources,
    deep2d_backdrop_gpu::{BackdropBaseDraw, Deep2dBackdropGpuResources},
    deep2d_dynamic_gpu::{Deep2dDynamicPathGpuResources, StencilTarget},
    deep2d_gpu_cache::Deep2dGpuAssetCache,
};

pub(super) const SHADER: &str = include_str!("../assets/shaders/native_deep2d_v1.wgsl");

// 宿主入口保持原路径:app/deep2d_context.rs 从本模块导入帧上下文。
pub use crate::deep2d_frame_context::{Deep2dFrameContext, deep2d_frame_context};
#[path = "deep2d_vertex_transfer.rs"]
mod vertex_transfer;
pub use vertex_transfer::VertexTransferStats;
#[path = "deep2d_draw_evidence.rs"]
mod draw_evidence;
pub use draw_evidence::DrawEvidence;
// 体量门拆分(行为零变化):路径资源族(管线/blend 管线/上传)与绘制编排
// (pass 分段/backdrop bracket)按既有 `#[path]` 子模块先例迁出。
#[path = "deep2d_gpu_path_resources.rs"]
mod path_resources;
use path_resources::Deep2dPathGpuResources;
#[path = "deep2d_gpu_draw.rs"]
mod draw;

pub struct Deep2dGpuPainter {
    device: wgpu::Device,
    path: Option<Deep2dPathGpuResources>,
    atlas: Option<Deep2dAtlasGpuResources>,
    /// 刀 3:动态路径 stencil 资源(动态块缺席时为 None,零开销)。
    dynamic: Option<Deep2dDynamicPathGpuResources>,
    /// 刀 3:按物理尺寸惰性创建的模板附件(动态块缺席的帧不附加)。
    stencil: std::cell::RefCell<Option<StencilTarget>>,
    /// 刀 4 毛玻璃捕获链(帧内无 backdrop 块时 None,零开销;捕获链按
    /// 区域尺寸惰性重建,与模板附件同为 &self 内可变)。
    backdrop: std::cell::RefCell<Option<Deep2dBackdropGpuResources>>,
    /// 刀 4 backdrop 块参数(绘制序 bracket 用)。
    backdrop_chunks: Vec<PreparedBackdropChunk>,
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
        let backdrop = std::cell::RefCell::new((!prepared.path.backdrop_chunks.is_empty())
            .then(|| Deep2dBackdropGpuResources::new(device, format)));
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
            backdrop,
            backdrop_chunks: std::mem::take(&mut prepared.path.backdrop_chunks),
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

    #[cfg(windows)]
    pub fn dashboard_video_slots(&self) -> &[DashboardVideoSlot] {
        &self.dashboard_video_slots
    }
    #[cfg(windows)]
    pub fn logical_size(&self) -> [f32; 2] {
        self.logical_size
    }
}

use std::sync::Arc;

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
