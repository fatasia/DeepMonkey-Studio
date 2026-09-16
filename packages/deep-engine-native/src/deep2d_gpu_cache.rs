//! Cross-frame asset cache for `Deep2dGpuPainter`.
//!
//! The cache lives exactly as long as one renderer/device epoch: objects are
//! reused across display-list updates on the same device and never survive a
//! device rebuild. Everything is keyed by content — path/atlas pipelines by
//! surface format, atlas textures by (atlas id, pixel-data hash), vertex
//! buffers by vertex-byte hash — with bounded oldest-generation eviction.
//! Hit/create counters are machine-readable evidence of reuse.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use crate::deep2d_atlas_gpu::ResidentAtlas;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Deep2dCacheStats {
    pub frame_layout_creates: u64,
    pub frame_layout_hits: u64,
    pub frame_buffer_creates: u64,
    pub frame_buffer_hits: u64,
    pub path_pipeline_creates: u64,
    pub path_pipeline_hits: u64,
    pub atlas_pipeline_creates: u64,
    pub atlas_pipeline_hits: u64,
    pub atlas_texture_creates: u64,
    pub atlas_texture_hits: u64,
    pub vertex_buffer_creates: u64,
    pub vertex_buffer_hits: u64,
    pub atlas_evictions: u64,
    pub vertex_evictions: u64,
}

const MAX_ATLAS_TEXTURES: usize = 16;
const MAX_VERTEX_BUFFERS: usize = 32;

struct Bounded<T> {
    capacity: usize,
    tick: u64,
    entries: HashMap<u64, (u64, Arc<T>)>,
}

impl<T> Bounded<T> {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            tick: 0,
            entries: HashMap::new(),
        }
    }

    fn next_tick(&mut self) -> u64 {
        self.tick += 1;
        self.tick
    }

    /// Inserts and evicts the least-recently-touched entry when over capacity.
    fn insert(&mut self, key: u64, value: Arc<T>) -> bool {
        let tick = self.next_tick();
        self.entries.insert(key, (tick, value));
        if self.entries.len() > self.capacity {
            let oldest = self
                .entries
                .iter()
                .filter(|(existing, _)| *existing != &key)
                .min_by_key(|(_, (stamp, _))| *stamp)
                .map(|(key, _)| *key);
            if let Some(key) = oldest {
                self.entries.remove(&key);
                return true;
            }
        }
        false
    }
}

/// Cached path-stage pipeline (shader + layout + pipeline for one format).
pub struct CachedPathPipelines {
    pub pipeline: Arc<wgpu::RenderPipeline>,
}

/// Cached atlas-stage pipeline plus its texture bind-group layout.
pub struct CachedAtlasPipelines {
    pub pipeline: Arc<wgpu::RenderPipeline>,
    pub atlas_layout: wgpu::BindGroupLayout,
}

pub struct Deep2dGpuAssetCache {
    inner: Mutex<CacheInner>,
}

struct CacheInner {
    stats: Deep2dCacheStats,
    frame_layout: Option<Arc<wgpu::BindGroupLayout>>,
    /// Frame uniform buffer + bind group keyed by (logical_width,
    /// logical_height) bits; identical canvas size reuses the upload.
    frame_resources: HashMap<u64, Arc<FrameResources>>,
    path_pipelines: HashMap<wgpu::TextureFormat, Arc<CachedPathPipelines>>,
    atlas_pipelines: HashMap<wgpu::TextureFormat, Arc<CachedAtlasPipelines>>,
    atlas_textures: Bounded<ResidentAtlas>,
    vertex_buffers: Bounded<wgpu::Buffer>,
}

/// A published frame uniform (logical size + reserved) with its bind group.
pub struct FrameResources {
    pub buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
}

impl Deep2dGpuAssetCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                stats: Deep2dCacheStats::default(),
                frame_layout: None,
                frame_resources: HashMap::new(),
                path_pipelines: HashMap::new(),
                atlas_pipelines: HashMap::new(),
                atlas_textures: Bounded::new(MAX_ATLAS_TEXTURES),
                vertex_buffers: Bounded::new(MAX_VERTEX_BUFFERS),
            }),
        }
    }

    /// Returns the cached frame buffer/bind-group pair for one logical size,
    /// or `None` when `create` must build it (call `store_frame` afterwards).
    /// Split so GPU creation stays at the call site with device handles.
    pub fn frame_resources(
        &self,
        logical_width: f32,
        logical_height: f32,
    ) -> Option<Arc<FrameResources>> {
        let mut inner = self.inner.lock().unwrap();
        let key = frame_key(logical_width, logical_height);
        if inner.frame_resources.contains_key(&key) {
            inner.stats.frame_buffer_hits += 1;
            return Some(Arc::clone(
                inner.frame_resources.get(&key).expect("checked above"),
            ));
        }
        None
    }

    pub fn store_frame_resources(
        &self,
        logical_width: f32,
        logical_height: f32,
        resources: FrameResources,
    ) -> Arc<FrameResources> {
        let mut inner = self.inner.lock().unwrap();
        inner.stats.frame_buffer_creates += 1;
        let key = frame_key(logical_width, logical_height);
        let resources = Arc::new(resources);
        // One live entry per distinct logical size is enough; identical size
        // means identical uniform bytes, so the map is its own dedupe.
        inner.frame_resources.insert(key, Arc::clone(&resources));
        Arc::clone(&resources)
    }

    pub fn frame_layout(
        &self,
        create: impl FnOnce() -> wgpu::BindGroupLayout,
    ) -> Arc<wgpu::BindGroupLayout> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(layout) = inner.frame_layout.as_ref().map(Arc::clone) {
            inner.stats.frame_layout_hits += 1;
            return layout;
        }
        inner.stats.frame_layout_creates += 1;
        let layout = Arc::new(create());
        inner.frame_layout = Some(Arc::clone(&layout));
        layout
    }

    pub fn path_pipelines(
        &self,
        format: wgpu::TextureFormat,
        create: impl FnOnce() -> CachedPathPipelines,
    ) -> Arc<CachedPathPipelines> {
        let mut inner = self.inner.lock().unwrap();
        if inner.path_pipelines.contains_key(&format) {
            inner.stats.path_pipeline_hits += 1;
            return Arc::clone(inner.path_pipelines.get(&format).unwrap());
        }
        inner.stats.path_pipeline_creates += 1;
        let cached = Arc::new(create());
        inner.path_pipelines.insert(format, Arc::clone(&cached));
        cached
    }

    pub fn atlas_pipelines(
        &self,
        format: wgpu::TextureFormat,
        create: impl FnOnce() -> CachedAtlasPipelines,
    ) -> Arc<CachedAtlasPipelines> {
        let mut inner = self.inner.lock().unwrap();
        if inner.atlas_pipelines.contains_key(&format) {
            inner.stats.atlas_pipeline_hits += 1;
            return Arc::clone(inner.atlas_pipelines.get(&format).unwrap());
        }
        inner.stats.atlas_pipeline_creates += 1;
        let cached = Arc::new(create());
        inner.atlas_pipelines.insert(format, Arc::clone(&cached));
        cached
    }

    /// Returns the cached atlas texture, or `None` when `create` must build it
    /// (call `store_atlas` afterwards). Split so GPU creation stays at the call
    /// site with its device handles.
    pub fn atlas_texture(&self, atlas_id: &str, data_key: u64) -> Option<Arc<ResidentAtlas>> {
        let mut inner = self.inner.lock().unwrap();
        let key = mix(atlas_key(atlas_id), data_key);
        if !inner.atlas_textures.entries.contains_key(&key) {
            return None;
        }
        let tick = inner.atlas_textures.next_tick();
        inner.stats.atlas_texture_hits += 1;
        let (stamp, texture) = inner.atlas_textures.entries.get_mut(&key).unwrap();
        *stamp = tick;
        Some(Arc::clone(texture))
    }

    pub fn store_atlas(&self, atlas_id: &str, data_key: u64, texture: Arc<ResidentAtlas>) {
        let mut inner = self.inner.lock().unwrap();
        let key = mix(atlas_key(atlas_id), data_key);
        inner.stats.atlas_texture_creates += 1;
        if inner.atlas_textures.insert(key, texture) {
            inner.stats.atlas_evictions += 1;
        }
    }

    pub fn vertex_buffer(&self, data_key: u64, len: usize) -> Option<Arc<wgpu::Buffer>> {
        let mut inner = self.inner.lock().unwrap();
        let key = mix(data_key, len as u64);
        if !inner.vertex_buffers.entries.contains_key(&key) {
            return None;
        }
        let tick = inner.vertex_buffers.next_tick();
        inner.stats.vertex_buffer_hits += 1;
        let (stamp, buffer) = inner.vertex_buffers.entries.get_mut(&key).unwrap();
        *stamp = tick;
        Some(Arc::clone(buffer))
    }

    pub fn store_vertex_buffer(&self, data_key: u64, len: usize, buffer: Arc<wgpu::Buffer>) {
        let mut inner = self.inner.lock().unwrap();
        let key = mix(data_key, len as u64);
        inner.stats.vertex_buffer_creates += 1;
        if inner.vertex_buffers.insert(key, buffer) {
            inner.stats.vertex_evictions += 1;
        }
    }

    pub fn stats(&self) -> Deep2dCacheStats {
        self.inner.lock().unwrap().stats.clone()
    }
}

fn mix(left: u64, right: u64) -> u64 {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write_u64(left);
    hasher.write_u64(right);
    hasher.finish()
}

fn frame_key(logical_width: f32, logical_height: f32) -> u64 {
    mix(
        u64::from(logical_width.to_bits()),
        u64::from(logical_height.to_bits()),
    )
}

fn atlas_key(atlas_id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    atlas_id.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::Bounded;

    #[test]
    fn bounded_evicts_oldest_generation() {
        let mut bounded: Bounded<u8> = Bounded::new(2);
        let keep = Arc::new(1_u8);
        assert!(!bounded.insert(1, Arc::clone(&keep)));
        assert!(!bounded.insert(2, Arc::new(2)));
        assert!(
            bounded.insert(3, Arc::new(3)),
            "over-capacity insert must evict"
        );
        assert_eq!(bounded.entries.len(), 2);
        assert!(!bounded.entries.contains_key(&1), "oldest entry must evict");
    }

    #[test]
    fn touching_keeps_entries_alive() {
        let mut bounded: Bounded<u8> = Bounded::new(2);
        let keep = Arc::new(1_u8);
        assert!(!bounded.insert(1, Arc::clone(&keep)));
        assert!(!bounded.insert(2, Arc::new(2)));
        // Touch entry 1, then insert 3: entry 2 must evict instead.
        let tick = bounded.next_tick();
        if let Some((stamp, _)) = bounded.entries.get_mut(&1) {
            *stamp = tick;
        }
        assert!(
            bounded.insert(3, Arc::new(3)),
            "over-capacity insert must evict"
        );
        assert!(bounded.entries.contains_key(&1));
        assert!(!bounded.entries.contains_key(&2));
    }
}
