use super::{ShadowCascadeKey, ShadowCasterSet, ShadowViewSource};
use deep_engine_native::culling_contract::{frustum_planes, sphere_visible};
use std::hash::Hasher;

#[derive(Clone, Debug)]
pub(super) struct CachedView {
    matrix: [[u32; 4]; 4],
    view: u64,
    casters: u64,
}

#[cfg(test)]
#[path = "shadow_caster_keys_tests.rs"]
mod tests;

impl ShadowCasterSet {
    #[cfg(test)]
    pub(crate) fn clear_view_key_cache_for_test(&self) {
        self.view_keys.borrow_mut().clear();
    }

    pub fn keys(
        &self,
        views: &impl ShadowViewSource,
        shader_revision: u64,
    ) -> Result<Vec<ShadowCascadeKey>, String> {
        let count = views.shadow_view_count() as usize;
        if count > super::MAX_CASCADES {
            return Err("shadow view count exceeds the native layer budget".into());
        }
        let mut cache = self.view_keys.borrow_mut();
        cache.resize_with(count, || None);
        (0..count)
            .map(|index| {
                let matrix = views.shadow_view_projection(index);
                let bits = matrix.map(|row| row.map(f32::to_bits));
                if let Some(cached) = &cache[index]
                    && cached.matrix == bits
                {
                    return Ok(ShadowCascadeKey {
                        view: cached.view,
                        casters: cached.casters,
                        shader: shader_revision,
                    });
                }
                let planes = frustum_planes(matrix)?;
                let mut view = std::collections::hash_map::DefaultHasher::new();
                for value in bits.into_iter().flatten() {
                    view.write_u32(value);
                }
                let mut casters = std::collections::hash_map::DefaultHasher::new();
                let mut visible = 0_u64;
                for caster in &self.casters {
                    if sphere_visible(&planes, &caster.instance, caster.bound) {
                        casters.write_u64(caster.fingerprint);
                        visible += 1;
                    }
                }
                casters.write_u64(visible);
                let cached = CachedView {
                    matrix: bits,
                    view: view.finish(),
                    casters: casters.finish(),
                };
                let key = ShadowCascadeKey {
                    view: cached.view,
                    casters: cached.casters,
                    shader: shader_revision,
                };
                // 投射物集合仅由 prepare 创建；场景替换生成新集合，不复用旧集合缓存。
                cache[index] = Some(cached);
                Ok(key)
            })
            .collect()
    }
}
