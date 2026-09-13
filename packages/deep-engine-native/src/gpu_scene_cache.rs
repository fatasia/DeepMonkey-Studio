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
    pub(super) epoch: u64,
    pub(super) revisions: SceneRevisionTicket,
    pub(super) scene: GpuScene,
    pub(super) manifest: SceneResourceManifest,
    pub(super) new_geometries: Vec<(VersionKey, Arc<GpuGeometry>)>,
    pub(super) new_textures: Vec<(VersionKey, Arc<GpuTexture>)>,
    pub(super) new_materials: Vec<(MaterialResourceIdentity, Arc<GpuMaterial>)>,
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
    pub(super) epoch: u64,
    pub(super) device: wgpu::Device,
    pub(super) revisions: SceneResourceDomain,
    pub(super) geometries: HashMap<VersionKey, Weak<GpuGeometry>>,
    pub(super) textures: HashMap<VersionKey, Weak<GpuTexture>>,
    pub(super) materials: HashMap<MaterialResourceIdentity, Weak<GpuMaterial>>,
    pub(super) instances: HashMap<ContentFingerprint, Weak<GpuInstanceResource>>,
    pub(super) latest_instance: Weak<GpuInstanceResource>,
    pub(super) fallbacks: Weak<Vec<GpuTexture>>,
}

impl GpuSceneCache {
    pub fn new(device: &wgpu::Device, epoch: u64) -> Self {
        Self {
            epoch,
            device: device.clone(),
            revisions: SceneResourceDomain::new(epoch),
            geometries: HashMap::new(),
            textures: HashMap::new(),
            materials: HashMap::new(),
            instances: HashMap::new(),
            latest_instance: Weak::new(),
            fallbacks: Weak::new(),
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    #[allow(dead_code)]
    pub fn reset(&mut self, device: &wgpu::Device, epoch: u64) {
        self.epoch = epoch;
        self.device = device.clone();
        self.revisions.reset(epoch);
        self.geometries.clear();
        self.textures.clear();
        self.materials.clear();
        self.instances.clear();
        self.latest_instance = Weak::new();
        self.fallbacks = Weak::new();
    }

    pub fn commit(&mut self, candidate: GpuSceneCandidate) -> Result<GpuScene, String> {
        if candidate.epoch != self.epoch {
            return Err("native scene candidate belongs to a stale GPU device epoch".into());
        }
        self.revisions.commit(candidate.revisions)?;
        self.geometries.retain(|_, value| value.strong_count() > 0);
        self.textures.retain(|_, value| value.strong_count() > 0);
        self.materials.retain(|_, value| value.strong_count() > 0);
        self.instances.retain(|_, value| value.strong_count() > 0);
        self.geometries.extend(
            candidate
                .new_geometries
                .iter()
                .map(|(key, value)| (key.clone(), Arc::downgrade(value))),
        );
        self.textures.extend(
            candidate
                .new_textures
                .iter()
                .map(|(key, value)| (key.clone(), Arc::downgrade(value))),
        );
        self.materials.extend(
            candidate
                .new_materials
                .iter()
                .map(|(key, value)| (key.clone(), Arc::downgrade(value))),
        );
        self.instances.insert(
            candidate.manifest.instances.clone(),
            Arc::downgrade(&candidate.instance),
        );
        self.latest_instance = Arc::downgrade(&candidate.instance);
        self.fallbacks = Arc::downgrade(&candidate.fallbacks);
        Ok(candidate.scene)
    }

    pub fn live_resources(&self) -> GpuSceneCacheLive {
        GpuSceneCacheLive {
            geometries: live(&self.geometries),
            textures: live(&self.textures),
            materials: live(&self.materials),
            instance_buffers: live(&self.instances),
        }
    }
}

fn live<K, T>(values: &HashMap<K, Weak<T>>) -> usize {
    values
        .values()
        .filter(|value| value.strong_count() > 0)
        .count()
}
