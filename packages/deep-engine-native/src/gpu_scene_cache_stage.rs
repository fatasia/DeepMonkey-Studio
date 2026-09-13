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
    gpu_scene_cache_instances::stage_instance_update,
    gpu_texture_upload::{GpuTexture, create_fallbacks, upload_texture},
    gpu_textures::{GpuMaterial, GpuPbrResources},
};

type VersionedStage<T> = (Vec<Arc<T>>, Vec<(VersionKey, Arc<T>)>);
type MaterialStage = (
    Vec<Arc<GpuMaterial>>,
    Vec<(MaterialResourceIdentity, Arc<GpuMaterial>)>,
);

impl GpuSceneCache {
    #[allow(clippy::too_many_arguments)]
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
        if device != &self.device {
            return Err("native scene cache belongs to another GPU device epoch".into());
        }
        let manifest = scene_resource_manifest(packet, prepared, pbr)?;
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
        let instance = if let Some(value) = self
            .instances
            .get(&manifest.instances)
            .and_then(Weak::upgrade)
        {
            metrics.instance_buffer_reuses = 1;
            value
        } else {
            metrics.instance_buffer_uploads = 1;
            let previous = self.latest_instance.upgrade();
            let (value, transfer) =
                stage_instance_update(device, queue, previous.as_ref(), &prepared.instances);
            metrics.instance_uploaded_bytes = transfer.uploaded_bytes;
            metrics.instance_copied_bytes = transfer.copied_bytes;
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
        Ok(GpuSceneCandidate {
            epoch: self.epoch,
            revisions,
            scene,
            manifest,
            new_geometries,
            new_textures,
            new_materials,
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
                if let Some(value) = self.geometries.get(&key).and_then(Weak::upgrade) {
                    metrics.geometry_reuses += 1;
                    value
                } else {
                    metrics.geometry_uploads += 1;
                    let value = Arc::new(GpuGeometry::new(device, source));
                    pending.push((key, Arc::clone(&value)));
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
                if let Some(value) = self.textures.get(&key).and_then(Weak::upgrade) {
                    metrics.texture_reuses += 1;
                    Ok(value)
                } else {
                    metrics.texture_uploads += 1;
                    let value = Arc::new(upload_texture(device, queue, source)?);
                    pending.push((key, Arc::clone(&value)));
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
