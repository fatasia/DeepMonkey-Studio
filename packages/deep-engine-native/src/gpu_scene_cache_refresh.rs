//! C3 场景刷新 staging(2026-09-19):实例内容变化(LOD profile / 阴影标志 /
//! 批重排类变更)而资源身份不变时,跳过纹理解码(`prepare_pbr_resources`)
//! 与整包内容哈希(`scene_resource_manifest`),按已提交清单的版本键复用全部
//! 已驻留 GPU 资源,仅重建实例缓冲(copy-diff)与批表。
//!
//! 安全合同(两条防线,任一不过由调用方回落全量路径):
//! 1. `probe_scene_refresh` 纯缓存核对:已提交清单存在、域一致、几何/纹理
//!    (id,revision) 列表与 packet 逐位一致、材质 id 列表一致——身份守卫由
//!    stage 侧 diff + 分类保证,这里是纵深防御;
//! 2. `stage_scene_refresh` 资源查取:任何 Weak 失活(驱逐/释放)即 Err,
//!    绝不静默重上传(重上传意味着身份已不在驻留集,必须走全量路径重建
//!    版本登记)。
//!
//! 信任边界与既有 transform-only / uniform-only 快路径一致:(id,revision)
//! 不变 ⇒ 内容不变。该合同由全量路径的 revision 域强制(同版本键换内容
//! fail-closed),快路径不重复验证。

use std::sync::{Arc, Weak};

use deep_engine_native::{
    contract::RenderPacket,
    pbr_texture::PreparedPbrSummary,
    scene::PreparedScene,
    scene_resource_identity::instance_fingerprint,
};

use crate::{
    gpu_scene::{GpuGeometry, GpuScene},
    gpu_scene_cache::{GpuSceneCache, GpuSceneCacheMetrics, GpuSceneCandidate, VersionKey},
    gpu_texture_upload::{GpuTexture, create_fallbacks},
    gpu_textures::{GpuMaterial, GpuPbrResources},
};

impl GpuSceneCache {
    /// 刷新 staging 的前置核对(纯缓存读,零 GPU 工作)。Err = 前置不成立,
    /// 调用方必须回落全量路径。
    pub fn probe_scene_refresh(&self, packet: &RenderPacket, domain: &str) -> Result<(), String> {
        let Some(manifest) = self.committed_manifest.as_ref() else {
            return Err("scene refresh has no committed resource manifest".into());
        };
        if domain != self.active_domain || !self.domains.contains(domain) {
            return Err("scene refresh requires the active resource domain".into());
        }
        // stage_scoped 对非空域把清单 id 包成 (domain, id) 的 JSON 字符串;
        // 核对时对 packet id 做同样包装,再与清单 id 逐条比对。
        let scoped_id =
            |id: &str| -> String {
                if domain.is_empty() {
                    id.to_string()
                } else {
                    serde_json::to_string(&(domain, id)).unwrap_or_else(|_| id.to_string())
                }
            };
        let geometry_matches = manifest
            .geometries
            .iter()
            .zip(packet.geometries.iter())
            .all(|(identity, geometry)| {
                identity.id == scoped_id(&geometry.id) && identity.revision == geometry.revision
            })
            && manifest.geometries.len() == packet.geometries.len();
        if !geometry_matches {
            return Err("scene refresh geometry identity drifted from the committed manifest".into());
        }
        let texture_matches = manifest
            .textures
            .iter()
            .zip(packet.textures.iter())
            .all(|(identity, texture)| {
                identity.id == scoped_id(&texture.id) && identity.revision == texture.revision
            })
            && manifest.textures.len() == packet.textures.len();
        if !texture_matches {
            return Err("scene refresh texture identity drifted from the committed manifest".into());
        }
        let material_matches = manifest
            .materials
            .iter()
            .zip(packet.materials.iter())
            .all(|(identity, material)| identity.id == scoped_id(&material.id))
            && manifest.materials.len() == packet.materials.len();
        if !material_matches {
            return Err("scene refresh material identity drifted from the committed manifest".into());
        }
        Ok(())
    }

    /// 资源全复用的场景刷新:几何/纹理/材质按已提交清单版本键复用,实例
    /// 缓冲按内容指纹复用或 copy-diff 上传,批表按 `prepared` 重建。
    /// 材质全部复用时不需要 bind-group layout(不新建 GpuMaterial)。
    #[allow(clippy::too_many_arguments)]
    pub fn stage_scene_refresh(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        packet: &RenderPacket,
        scene_key: u64,
        prepared: &PreparedScene,
        pbr_summary: PreparedPbrSummary,
        domain: &str,
    ) -> Result<GpuSceneCandidate, String> {
        self.probe_scene_refresh(packet, domain)?;
        if device != &self.device {
            return Err("native scene cache belongs to another GPU device epoch".into());
        }
        let manifest = self
            .committed_manifest
            .as_ref()
            .ok_or("scene refresh lost its committed manifest")?
            .clone();
        let mut metrics = GpuSceneCacheMetrics::default();

        let geometries = manifest
            .geometries
            .iter()
            .map(|identity| {
                self.geometries
                    .get(&VersionKey(identity.id.clone(), identity.revision))
                    .and_then(|(weak, _)| weak.upgrade())
                    .ok_or_else(|| format!("scene refresh geometry {} is not resident", identity.id))
            })
            .collect::<Result<Vec<Arc<GpuGeometry>>, String>>()?;
        metrics.geometry_reuses = geometries.len();

        let textures = manifest
            .textures
            .iter()
            .map(|identity| {
                self.textures
                    .get(&VersionKey(identity.id.clone(), identity.revision))
                    .and_then(|(weak, _)| weak.upgrade())
                    .ok_or_else(|| format!("scene refresh texture {} is not resident", identity.id))
            })
            .collect::<Result<Vec<Arc<GpuTexture>>, String>>()?;
        metrics.texture_reuses = textures.len();

        let materials = manifest
            .materials
            .iter()
            .map(|identity| {
                self.materials
                    .get(identity)
                    .and_then(Weak::upgrade)
                    .ok_or_else(|| format!("scene refresh material {} is not resident", identity.id))
            })
            .collect::<Result<Vec<Arc<GpuMaterial>>, String>>()?;
        metrics.material_reuses = materials.len();

        let fallbacks = if materials.is_empty() {
            Arc::new(Vec::new())
        } else if let Some(fallbacks) = self.fallbacks.upgrade() {
            fallbacks
        } else {
            create_fallbacks(device, queue).map(Arc::new)?
        };

        let fingerprint = instance_fingerprint(prepared);
        let (instance, new_instance_bytes) =
            if let Some(value) = self
                .instances
                .get(&fingerprint)
                .and_then(|(weak, _)| weak.upgrade())
            {
                metrics.instance_buffer_reuses = 1;
                (value, None)
            } else {
                metrics.instance_buffer_uploads = 1;
                let previous = self.latest_instance.upgrade();
                let (value, transfer) =
                    self.instance_ring
                    .borrow_mut()
                    .stage(device, queue, previous.as_ref(), &prepared.instances);
                metrics.instance_uploaded_bytes = transfer.uploaded_bytes;
                metrics.instance_copied_bytes = transfer.copied_bytes;
                (Arc::clone(&value), Some(value.buffer.size()))
            };

        // 版本登记:资源身份与已提交清单一致 → 零新增登记条目,仅复核。
        let revisions = self.revisions.stage(&manifest)?;
        let mut candidate_manifest = manifest;
        candidate_manifest.instances = fingerprint;
        let scene = GpuScene::from_resources(
            geometries,
            instance.clone(),
            prepared.batches.clone(),
            GpuPbrResources::from_resources(textures, fallbacks.clone(), materials, pbr_summary),
            scene_key,
            device,
        );
        Ok(GpuSceneCandidate {
            domain: domain.into(),
            epoch: self.epoch,
            revisions,
            scene,
            manifest: candidate_manifest,
            new_geometries: Vec::new(),
            new_textures: Vec::new(),
            new_materials: Vec::new(),
            new_resident_bytes: new_instance_bytes.unwrap_or(0),
            new_instance_bytes,
            instance,
            fallbacks,
            metrics,
        })
    }
}
