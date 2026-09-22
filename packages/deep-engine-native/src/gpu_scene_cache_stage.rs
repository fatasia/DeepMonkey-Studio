use std::sync::{Arc, Weak};

use deep_engine_native::{
    contract::RenderPacket,
    pbr_texture::PreparedPbrResources,
    scene::PreparedScene,
    scene_resource_identity::{
        MaterialResourceIdentity, SceneResourceManifest, VersionedResourceIdentity,
        scene_resource_manifest,
    },
};

use crate::{
    gpu_scene::{GpuGeometry, GpuScene},
    gpu_scene_cache::{GpuSceneCache, GpuSceneCacheMetrics, GpuSceneCandidate, VersionKey},
    gpu_texture_upload::{GpuTexture, create_fallbacks, upload_texture},
    gpu_textures::{GpuMaterial, GpuPbrResources},
};

type VersionedStage<T> = (Vec<Arc<T>>, Vec<(VersionKey, Arc<T>, u64)>);
type MaterialStage = (
    Vec<Arc<GpuMaterial>>,
    Vec<(MaterialResourceIdentity, Arc<GpuMaterial>)>,
);

impl GpuSceneCache {
    #[allow(clippy::too_many_arguments, dead_code)] // Independent cache tests use the default domain.
    pub fn stage(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        material_layout: &wgpu::BindGroupLayout,
        packet: &RenderPacket,
        scene_key: u64,
        prepared: &PreparedScene,
        pbr: &PreparedPbrResources,
    ) -> Result<GpuSceneCandidate, String> {
        self.stage_scoped(
            device,
            queue,
            material_layout,
            packet,
            scene_key,
            prepared,
            pbr,
            "",
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stage_scoped(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        material_layout: &wgpu::BindGroupLayout,
        packet: &RenderPacket,
        scene_key: u64,
        prepared: &PreparedScene,
        pbr: &PreparedPbrResources,
        domain: &str,
    ) -> Result<GpuSceneCandidate, String> {
        if !self.domains.contains(domain) && self.domains.len() >= 256 {
            return Err("native scene source-domain budget exhausted; reopen Viewer".into());
        }
        if device != &self.device {
            return Err("native scene cache belongs to another GPU device epoch".into());
        }
        let mut manifest = scene_resource_manifest(packet, prepared, pbr)?;
        if !domain.is_empty() {
            for identity in manifest.geometries.iter_mut().chain(&mut manifest.textures) {
                identity.id =
                    serde_json::to_string(&(domain, &identity.id)).map_err(|e| e.to_string())?;
            }
            for identity in &mut manifest.materials {
                identity.id =
                    serde_json::to_string(&(domain, &identity.id)).map_err(|e| e.to_string())?;
            }
        }
        let revisions = self.revisions.stage(&manifest)?;
        let mut metrics = GpuSceneCacheMetrics::default();
        let (geometries, new_geometries) =
            self.stage_geometries(device, packet, &manifest, &mut metrics);
        let (textures, new_textures) =
            self.stage_textures(device, queue, pbr, &manifest, &mut metrics)?;
        let fallbacks = self.stage_fallbacks(device, queue, pbr)?;
        let (materials, new_materials) = self.stage_materials(
            device,
            material_layout,
            pbr,
            &manifest,
            &textures,
            &fallbacks,
            &mut metrics,
        )?;
        let mut new_instance_bytes = None;
        let instance = if let Some(value) = self
            .instances
            .get(&manifest.instances)
            .and_then(|(weak, _)| weak.upgrade())
        {
            metrics.instance_buffer_reuses = 1;
            std::sync::Arc::clone(&value)
        } else {
            metrics.instance_buffer_uploads = 1;
            let previous = self.latest_instance.upgrade();
            let (value, transfer) = self.instance_ring.borrow_mut().stage(
                device,
                queue,
                previous.as_ref(),
                &prepared.instances,
            );
            metrics.instance_uploaded_bytes = transfer.uploaded_bytes;
            metrics.instance_copied_bytes = transfer.copied_bytes;
            new_instance_bytes = Some(value.buffer.size());
            value
        };
        let scene = GpuScene::from_resources(
            geometries,
            Arc::clone(&instance),
            prepared.batches.clone(),
            GpuPbrResources::from_resources(
                textures,
                Arc::clone(&fallbacks),
                materials,
                pbr.summary(),
            ),
            scene_key,
            device,
        );
        let new_resident_bytes = new_geometries
            .iter()
            .map(|(_, _, bytes)| bytes)
            .sum::<u64>()
            + new_textures.iter().map(|(_, _, bytes)| bytes).sum::<u64>()
            + new_instance_bytes.unwrap_or(0);
        Ok(GpuSceneCandidate {
            domain: domain.into(),
            epoch: self.epoch,
            revisions,
            scene,
            manifest,
            new_geometries,
            new_textures,
            new_materials,
            new_resident_bytes,
            new_instance_bytes,
            instance,
            fallbacks,
            metrics,
        })
    }

    fn stage_geometries(
        &self,
        device: &wgpu::Device,
        packet: &RenderPacket,
        manifest: &SceneResourceManifest,
        metrics: &mut GpuSceneCacheMetrics,
    ) -> VersionedStage<GpuGeometry> {
        let mut pending = Vec::new();
        let values = packet
            .geometries
            .iter()
            .zip(&manifest.geometries)
            .map(|(source, identity)| {
                let key = version(identity);
                if let Some(value) = self
                    .geometries
                    .get(&key)
                    .and_then(|(weak, _)| weak.upgrade())
                {
                    metrics.geometry_reuses += 1;
                    value
                } else {
                    metrics.geometry_uploads += 1;
                    let value = Arc::new(GpuGeometry::new(device, source));
                    let bytes = value.vertex_buffer.size()
                        + value.index_buffer.size()
                        + value
                            .tangent_buffer
                            .as_ref()
                            .map_or(0, |buffer| buffer.size());
                    pending.push((key, Arc::clone(&value), bytes));
                    value
                }
            })
            .collect();
        (values, pending)
    }

    fn stage_textures(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pbr: &PreparedPbrResources,
        manifest: &SceneResourceManifest,
        metrics: &mut GpuSceneCacheMetrics,
    ) -> Result<VersionedStage<GpuTexture>, String> {
        let mut pending = Vec::new();
        let values = pbr
            .textures
            .iter()
            .zip(&manifest.textures)
            .map(|(source, identity)| {
                let key = version(identity);
                if let Some(value) = self.textures.get(&key).and_then(|(weak, _)| weak.upgrade()) {
                    metrics.texture_reuses += 1;
                    Ok(value)
                } else {
                    metrics.texture_uploads += 1;
                    let value = Arc::new(upload_texture(device, queue, source)?);
                    let bytes: u64 = source
                        .levels
                        .iter()
                        .map(|level| u64::from(level.width) * u64::from(level.height) * 4)
                        .sum();
                    pending.push((key, Arc::clone(&value), bytes));
                    Ok(value)
                }
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok((values, pending))
    }

    fn stage_fallbacks(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pbr: &PreparedPbrResources,
    ) -> Result<Arc<Vec<GpuTexture>>, String> {
        if pbr.materials.is_empty() {
            return Ok(Arc::new(Vec::new()));
        }
        self.fallbacks
            .upgrade()
            .map_or_else(|| create_fallbacks(device, queue).map(Arc::new), Ok)
    }

    #[allow(clippy::too_many_arguments)]
    fn stage_materials(
        &self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        pbr: &PreparedPbrResources,
        manifest: &SceneResourceManifest,
        textures: &[Arc<GpuTexture>],
        fallbacks: &[GpuTexture],
        metrics: &mut GpuSceneCacheMetrics,
    ) -> Result<MaterialStage, String> {
        let mut pending = Vec::new();
        let values = pbr
            .materials
            .iter()
            .zip(&manifest.materials)
            .map(|(source, identity)| {
                if let Some(value) = self.materials.get(identity).and_then(Weak::upgrade) {
                    metrics.material_reuses += 1;
                    Ok(value)
                } else {
                    metrics.material_uploads += 1;
                    let value = Arc::new(GpuMaterial::new(
                        device, layout, source, textures, fallbacks,
                    )?);
                    pending.push((identity.clone(), Arc::clone(&value)));
                    Ok(value)
                }
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok((values, pending))
    }
}

fn version(identity: &VersionedResourceIdentity) -> VersionKey {
    VersionKey(identity.id.clone(), identity.revision)
}
