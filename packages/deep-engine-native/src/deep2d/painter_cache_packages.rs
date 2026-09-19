//! Bounded reuse of fully validated immutable package preparation, within the existing cache owner.
use super::Deep2dPathCache;
use crate::deep2d::{Deep2dRuntimeContent, PreparedDeep2dRuntime};
use std::{collections::HashMap, sync::Arc};
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 256;
struct Entry {
    source: Arc<Deep2dRuntimeContent>,
    prepared: PreparedDeep2dRuntime,
    epoch: Option<u64>,
    scale: Option<u64>,
    used: u64,
    bytes: usize,
}
#[derive(Default)]
pub(super) struct PackageCache {
    entries: HashMap<String, Entry>,
    bytes: usize,
    tick: u64,
}
impl Deep2dPathCache {
    pub(crate) fn package_atlases(
        &self,
        package: &crate::deep2d::Deep2dRuntimePackage,
    ) -> Option<Vec<crate::deep2d::PreparedDeep2dAtlas>> {
        let entry = self.packages.as_ref()?.entries.get(&package.id)?;
        let Deep2dRuntimeContent::Package(previous) = entry.source.as_ref() else {
            return None;
        };
        // Typed metadata AND every encoded byte must match a successfully prepared source.
        // Camera affects geometry, not the decoded atlas pixels.
        (entry.epoch == self.resource_epoch && previous.atlases == package.atlases)
            .then(|| entry.prepared.atlases.clone())
    }
    pub fn with_package_cache() -> Self {
        Self {
            packages: Some(PackageCache::default()),
            ..Self::default()
        }
    }
    pub(crate) fn prepared_package(
        &mut self,
        source: &Arc<Deep2dRuntimeContent>,
    ) -> Option<PreparedDeep2dRuntime> {
        let Deep2dRuntimeContent::Package(package) = source.as_ref() else {
            return None;
        };
        let cache = self.packages.as_mut()?;
        let entry = cache.entries.get_mut(&package.id)?;
        if entry.epoch != self.resource_epoch
            || entry.scale != self.camera_scale.map(f64::to_bits)
            || entry.source.as_ref() != source.as_ref()
        {
            return None;
        }
        cache.tick = cache.tick.wrapping_add(1);
        entry.used = cache.tick;
        Some(entry.prepared.clone())
    }
    pub(crate) fn remember_package(
        &mut self,
        source: &Arc<Deep2dRuntimeContent>,
        prepared: &PreparedDeep2dRuntime,
    ) {
        let Deep2dRuntimeContent::Package(package) = source.as_ref() else {
            return;
        };
        let Some(cache) = self.packages.as_mut() else {
            return;
        };
        // Validated canonical base64 is ASCII without JSON escapes. Account its
        // exact length without serializing every pixel again on a style change.
        let mut metadata = package.clone();
        let mut pixel_characters = 0usize;
        for atlas in &mut metadata.atlases {
            pixel_characters = pixel_characters.saturating_add(atlas.data_base64.len());
            atlas.data_base64.clear();
        }
        let Ok(encoded) = serde_json::to_vec(&metadata) else {
            return;
        };
        let bytes = encoded
            .len()
            .saturating_add(pixel_characters)
            .saturating_add(prepared.summary.atlas_bytes)
            .saturating_add(prepared.path.vertices.len() * std::mem::size_of_val(&[0f32; 6]))
            .saturating_add(prepared.atlas_vertices.len() * std::mem::size_of_val(&[0f32; 13]))
            .saturating_add(
                prepared.chunks.len() * std::mem::size_of::<crate::deep2d::PreparedDeep2dChunk>(),
            )
            .saturating_add(prepared.path.chunks.len() * 256);
        if bytes > MAX_BYTES {
            return;
        }
        if let Some(old) = cache.entries.remove(&package.id) {
            cache.bytes -= old.bytes;
        }
        while cache.entries.len() >= MAX_ENTRIES || cache.bytes + bytes > MAX_BYTES {
            let Some(id) = cache
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            if let Some(old) = cache.entries.remove(&id) {
                cache.bytes -= old.bytes;
            }
        }
        cache.tick = cache.tick.wrapping_add(1);
        cache.bytes += bytes;
        cache.entries.insert(
            package.id.clone(),
            Entry {
                source: source.clone(),
                prepared: prepared.clone(),
                epoch: self.resource_epoch,
                scale: self.camera_scale.map(f64::to_bits),
                used: cache.tick,
                bytes,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Arc<Deep2dRuntimeContent> {
        Arc::new(
            crate::deep2d::decode_runtime_content(include_bytes!(
                "../../fixtures/deep2d_runtime_atlas_v1.json"
            ))
            .unwrap(),
        )
    }
    #[test]
    fn prepared_packages_bind_exact_content_camera_epoch_and_return_independent_bytes() {
        let source = source();
        let prepared = crate::deep2d::prepare_runtime_content(&source).unwrap();
        let mut cache = Deep2dPathCache::with_package_cache();
        cache.set_resource_epoch(1);
        cache.set_camera_scale(1.0);
        cache.remember_package(&source, &prepared);
        assert_eq!(cache.prepared_package(&source).unwrap(), prepared);
        let mut copy = cache.prepared_package(&source).unwrap();
        copy.atlases[0].data[0] ^= 1;
        assert_eq!(cache.prepared_package(&source).unwrap(), prepared);
        cache.set_camera_scale(2.0);
        assert!(cache.prepared_package(&source).is_none());
        cache.set_camera_scale(1.0);
        cache.set_resource_epoch(2);
        assert!(cache.prepared_package(&source).is_none());
        cache.set_resource_epoch(1);
        let mut changed = (*source).clone();
        if let Deep2dRuntimeContent::Package(package) = &mut changed {
            package.atlases[0].data_base64 = "AB==".into();
        }
        let changed = Arc::new(changed);
        assert!(cache.prepared_package(&changed).is_none());
        assert!(crate::deep2d::prepare_runtime_content_cached(&changed, &mut cache).is_err());
        assert_eq!(cache.prepared_package(&source).unwrap(), prepared);
    }
    #[test]
    fn prepared_package_entries_are_lru_bounded() {
        let source = source();
        let prepared = crate::deep2d::prepare_runtime_content(&source).unwrap();
        let mut cache = Deep2dPathCache::with_package_cache();
        for index in 0..300 {
            let mut source = (*source).clone();
            if let Deep2dRuntimeContent::Package(package) = &mut source {
                package.id = format!("package-{index}");
            }
            cache.remember_package(&Arc::new(source), &prepared);
        }
        let state = cache.packages.as_ref().unwrap();
        assert_eq!(state.entries.len(), MAX_ENTRIES);
        assert!(state.bytes <= MAX_BYTES);
        assert!(!state.entries.contains_key("package-0"));
        assert!(state.entries.contains_key("package-299"));
    }

    #[test]
    fn atlas_reuse_keeps_style_quad_metadata_and_pixel_validation_live() {
        let source = source();
        let prepared = crate::deep2d::prepare_runtime_content(&source).unwrap();
        let mut cache = Deep2dPathCache::with_package_cache();
        cache.remember_package(&source, &prepared);
        let mut changed = (*source).clone();
        let Deep2dRuntimeContent::Package(package) = &mut changed else {
            panic!()
        };
        if let crate::deep2d::Deep2dCommand::Path(path) = &mut package.display_list.commands[0] {
            path.fill = Some([0.2, 0.3, 0.4, 0.5]);
        }
        assert!(cache.package_atlases(package).is_some());
        assert_eq!(
            crate::deep2d::prepare_runtime_content_cached(&changed, &mut cache).unwrap(),
            crate::deep2d::prepare_runtime_content(&changed).unwrap()
        );
        let Deep2dRuntimeContent::Package(package) = &mut changed else {
            panic!()
        };
        package.quads[0].atlas_id = "absent".into();
        assert!(cache.package_atlases(package).is_some());
        assert!(crate::deep2d::prepare_runtime_content_cached(&changed, &mut cache).is_err());
        for pixels in [false, true] {
            let mut changed = (*source).clone();
            let Deep2dRuntimeContent::Package(package) = &mut changed else {
                panic!()
            };
            if pixels {
                package.atlases[0].data_base64 = "AB==".into();
            } else {
                package.atlases[0].width += 1;
            }
            assert!(cache.package_atlases(package).is_none());
            assert!(crate::deep2d::prepare_runtime_content_cached(&changed, &mut cache).is_err());
        }
    }
}
