use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};

use deep_engine_native::{
    scene_resource_domain::{SceneResourceDomain, SceneRevisionTicket},
    scene_resource_identity::{
        ContentFingerprint, MaterialResourceIdentity, SceneResourceManifest,
    },
};

use crate::{
    gpu_scene::{GpuGeometry, GpuInstanceResource, GpuScene},
    gpu_scene_cache_instances::InstanceStagingRing,
    gpu_texture_upload::GpuTexture,
    gpu_textures::GpuMaterial,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GpuSceneCacheMetrics {
    pub geometry_uploads: usize,
    pub geometry_reuses: usize,
    pub texture_uploads: usize,
    pub texture_reuses: usize,
    pub material_uploads: usize,
    pub material_reuses: usize,
    pub instance_buffer_uploads: usize,
    pub instance_buffer_reuses: usize,
    pub instance_uploaded_bytes: u64,
    pub instance_copied_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GpuSceneCacheLive {
    pub geometries: usize,
    pub textures: usize,
    pub materials: usize,
    pub instance_buffers: usize,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub(super) struct VersionKey(pub String, pub u64);

pub struct GpuSceneCandidate {
    pub(super) domain: String,
    pub(super) epoch: u64,
    pub(super) revisions: SceneRevisionTicket,
    pub(super) scene: GpuScene,
    pub(super) manifest: SceneResourceManifest,
    pub(super) new_geometries: Vec<(VersionKey, Arc<GpuGeometry>, u64)>,
    pub(super) new_textures: Vec<(VersionKey, Arc<GpuTexture>, u64)>,
    pub(super) new_materials: Vec<(MaterialResourceIdentity, Arc<GpuMaterial>)>,
    /// Bytes the candidate adds on top of already-resident resources.
    pub(super) new_resident_bytes: u64,
    /// `Some` when the candidate uploaded a new instance buffer.
    pub(super) new_instance_bytes: Option<u64>,
    pub(super) instance: Arc<GpuInstanceResource>,
    pub(super) fallbacks: Arc<Vec<GpuTexture>>,
    pub(super) metrics: GpuSceneCacheMetrics,
}

impl GpuSceneCandidate {
    pub fn scene(&self) -> &GpuScene {
        &self.scene
    }

    pub fn scene_mut(&mut self) -> &mut GpuScene {
        &mut self.scene
    }

    pub fn metrics(&self) -> GpuSceneCacheMetrics {
        self.metrics
    }
}

pub struct GpuSceneCache {
    pub(super) domains: std::collections::HashSet<String>,
    pub(super) active_domain: String,
    pub(super) epoch: u64,
    pub(super) device: wgpu::Device,
    pub(super) revisions: SceneResourceDomain,
    pub(super) geometries: HashMap<VersionKey, (Weak<GpuGeometry>, u64)>,
    pub(super) textures: HashMap<VersionKey, (Weak<GpuTexture>, u64)>,
    pub(super) materials: HashMap<MaterialResourceIdentity, Weak<GpuMaterial>>,
    pub(super) instances: HashMap<ContentFingerprint, (Weak<GpuInstanceResource>, u64)>,
    pub(super) latest_instance: Weak<GpuInstanceResource>,
    /// B05: 实例暂存环,stage 与 refresh 共用;`&self` 入口经 RefCell 轮转。
    pub(super) instance_ring: std::cell::RefCell<InstanceStagingRing>,
    pub(super) fallbacks: Weak<Vec<GpuTexture>>,
    /// Resident-byte ceiling. Defaults from the device buffer limit with a
    /// conservative cap; explicit overrides replace it wholesale.
    pub(super) budget_bytes: u64,
    /// Strong-alive resident bytes over all retained entries.
    live_bytes: u64,
    peak_live_bytes: u64,
    /// C3 场景刷新 staging 的身份基线:最近一次 commit 的资源清单(几何/
    /// 纹理/材质身份向量)。实例内容变化而资源身份不变时,刷新路径凭它
    /// 跳过纹理解码与整包内容哈希;`reset` 清空,commit 覆盖。
    pub(super) committed_manifest: Option<SceneResourceManifest>,
}

/// Conservative default resident budget: twice the device buffer limit,
/// capped at 4 GiB and floored at 256 MiB.
pub fn default_budget(device: &wgpu::Device) -> u64 {
    let max_buffer = device.limits().max_buffer_size;
    (max_buffer.saturating_mul(2)).clamp(256 * 1024 * 1024, 4 * 1024 * 1024 * 1024)
}

impl GpuSceneCache {
    pub fn new(device: &wgpu::Device, epoch: u64) -> Self {
        Self {
            domains: Default::default(),
            active_domain: String::new(),
            epoch,
            device: device.clone(),
            revisions: SceneResourceDomain::new(epoch),
            budget_bytes: default_budget(device),
            geometries: HashMap::new(),
            textures: HashMap::new(),
            materials: HashMap::new(),
            instances: HashMap::new(),
            latest_instance: Weak::new(),
            instance_ring: std::cell::RefCell::new(
                InstanceStagingRing::new(),
            ),
            fallbacks: Weak::new(),
            live_bytes: 0,
            peak_live_bytes: 0,
            committed_manifest: None,
        }
    }

    /// Replaces the default resident-byte ceiling (builder-style).
    pub fn with_budget(mut self, budget_bytes: u64) -> Self {
        self.budget_bytes = budget_bytes;
        self
    }

    pub fn budget_bytes(&self) -> u64 {
        self.budget_bytes
    }

    pub fn live_bytes(&self) -> u64 {
        self.current_live_bytes()
    }

    pub fn peak_live_bytes(&self) -> u64 {
        self.peak_live_bytes
    }

    /// Recomputes strong-alive resident bytes from the byte-tagged entries.
    pub(super) fn recompute_live_bytes(&mut self) -> u64 {
        self.geometries
            .retain(|_, (weak, _)| weak.strong_count() > 0);
        self.textures.retain(|_, (weak, _)| weak.strong_count() > 0);
        self.instances
            .retain(|_, (weak, _)| weak.strong_count() > 0);
        let live = self.current_live_bytes();
        self.live_bytes = live;
        if self.live_bytes > self.peak_live_bytes {
            self.peak_live_bytes = self.live_bytes;
        }
        self.live_bytes
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn active_domain(&self) -> &str {
        &self.active_domain
    }

    #[allow(dead_code)]
    pub fn reset(&mut self, device: &wgpu::Device, epoch: u64) {
        self.epoch = epoch;
        self.device = device.clone();
        self.revisions.reset(epoch);
        self.domains.clear();
        self.active_domain.clear();
        self.geometries.clear();
        self.textures.clear();
        self.materials.clear();
        self.instances.clear();
        self.latest_instance = Weak::new();
        // reset 语义是整体弃用:槽位一并清空,避免跨 epoch 复用旧容量。
        self.instance_ring = std::cell::RefCell::new(
            InstanceStagingRing::new(),
        );
        self.fallbacks = Weak::new();
        self.live_bytes = 0;
        self.peak_live_bytes = 0;
        self.committed_manifest = None;
    }

    pub fn commit(&mut self, candidate: GpuSceneCandidate) -> Result<GpuScene, String> {
        self.validate_commit(&candidate)?;
        // 验证成功后才回收过期条目或修改资源身份。
        self.geometries
            .retain(|_, (weak, _)| weak.strong_count() > 0);
        self.textures.retain(|_, (weak, _)| weak.strong_count() > 0);
        self.materials.retain(|_, value| value.strong_count() > 0);
        self.instances
            .retain(|_, (weak, _)| weak.strong_count() > 0);
        self.committed_manifest = Some(candidate.manifest.clone());
        self.revisions.commit(candidate.revisions)?;
        self.domains.insert(candidate.domain.clone());
        self.active_domain = candidate.domain;
        self.geometries.extend(
            candidate
                .new_geometries
                .iter()
                .map(|(key, value, bytes)| (key.clone(), (Arc::downgrade(value), *bytes))),
        );
        self.textures.extend(
            candidate
                .new_textures
                .iter()
                .map(|(key, value, bytes)| (key.clone(), (Arc::downgrade(value), *bytes))),
        );
        self.materials.extend(
            candidate
                .new_materials
                .iter()
                .map(|(key, value)| (key.clone(), Arc::downgrade(value))),
        );
        if let Some(bytes) = candidate.new_instance_bytes {
            self.instances.insert(
                candidate.manifest.instances.clone(),
                (Arc::downgrade(&candidate.instance), bytes),
            );
        }
        self.latest_instance = Arc::downgrade(&candidate.instance);
        self.fallbacks = Arc::downgrade(&candidate.fallbacks);
        self.recompute_live_bytes();
        Ok(candidate.scene)
    }

    /// 不改缓存、资源修订或统计；提交仍复核，不能跨异步间隙当作授权票据。
    pub fn validate_commit(&self, candidate: &GpuSceneCandidate) -> Result<(), String> {
        if !self.domains.contains(&candidate.domain) && self.domains.len() >= 256 {
            return Err("native scene source-domain budget exhausted; reopen Viewer".into());
        }
        if candidate.epoch != self.epoch {
            return Err("native scene candidate belongs to a stale GPU device epoch".into());
        }
        let retained_live = self.current_live_bytes();
        let projected = retained_live.saturating_add(candidate.new_resident_bytes);
        if projected > self.budget_bytes {
            return Err(format!(
                "native scene candidate exceeds the resident budget: needs {projected} bytes                  (live {retained_live} + candidate {}), budget {}",
                candidate.new_resident_bytes, self.budget_bytes
            ));
        }
        self.revisions.validate_commit(&candidate.revisions)
    }

    pub fn live_resources(&self) -> GpuSceneCacheLive {
        GpuSceneCacheLive {
            geometries: live(&self.geometries),
            textures: live(&self.textures),
            materials: self
                .materials
                .values()
                .filter(|m| m.strong_count() > 0)
                .count(),
            instance_buffers: live(&self.instances),
        }
    }

    fn current_live_bytes(&self) -> u64 {
        tagged_live_bytes(&self.geometries)
            + tagged_live_bytes(&self.textures)
            + tagged_live_bytes(&self.instances)
    }
}

fn live<K, T>(values: &HashMap<K, (Weak<T>, u64)>) -> usize {
    values
        .values()
        .filter(|(weak, _)| weak.strong_count() > 0)
        .count()
}

fn tagged_live_bytes<K, T>(values: &HashMap<K, (Weak<T>, u64)>) -> u64 {
    values
        .values()
        .filter(|(weak, _)| weak.strong_count() > 0)
        .map(|(_, bytes)| bytes)
        .sum()
}
