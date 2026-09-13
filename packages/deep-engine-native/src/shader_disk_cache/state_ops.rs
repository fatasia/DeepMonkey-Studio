use std::sync::MutexGuard;

use super::{
    ShaderDiskCache,
    index_format::encode_index,
    index_types::{CacheIndex, CacheState},
    io,
    types::{
        DEEP_SHADER_DISK_CACHE_SCHEMA, DEEP_SHADER_DISK_CACHE_SCHEMA_VERSION,
        ShaderDiskCacheCancellation, ShaderDiskCacheError, ShaderDiskCacheErrorCode,
    },
};

impl ShaderDiskCache {
    pub fn flush(
        &self,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<(), ShaderDiskCacheError> {
        let mut state = self.lock_state()?;
        if !state.dirty_access {
            return Ok(());
        }
        let candidate = state.clone();
        self.publish(&mut state, candidate, cancellation)
    }

    pub(crate) fn enforce_limits(&self) -> Result<(), ShaderDiskCacheError> {
        let mut state = self.lock_state()?;
        let mut candidate = state.clone();
        self.trim(&mut candidate);
        if candidate.entries.len() != state.entries.len()
            || candidate.total_bytes != state.total_bytes
        {
            self.publish(&mut state, candidate, None)?;
        }
        Ok(())
    }

    pub(super) fn trim(&self, state: &mut CacheState) {
        while state.entries.len() > self.inner.config.max_entries
            || state.total_bytes > self.inner.config.max_bytes
        {
            let victim = state
                .entries
                .iter()
                .min_by_key(|(key, entry)| (entry.access_sequence, (*key).clone()))
                .map(|(key, _)| key.clone())
                .expect("over-budget cache has an entry");
            let removed = state.entries.remove(&victim).expect("selected cache entry");
            state.total_bytes -= removed.byte_length;
        }
    }

    pub(super) fn publish(
        &self,
        active: &mut MutexGuard<'_, CacheState>,
        mut candidate: CacheState,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<(), ShaderDiskCacheError> {
        io::check_cancel(cancellation)?;
        let previous_index = active.active_index_file.clone();
        let previous_records = active
            .entries
            .values()
            .map(|entry| entry.record_file.clone())
            .collect();
        candidate.generation = active.generation.checked_add(1).ok_or_else(|| {
            ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::CorruptIndex,
                "shader cache generation overflowed",
            )
        })?;
        let file_name = io::index_file_name(candidate.generation);
        let mut index = CacheIndex {
            schema: DEEP_SHADER_DISK_CACHE_SCHEMA.to_owned(),
            schema_version: DEEP_SHADER_DISK_CACHE_SCHEMA_VERSION,
            generation: candidate.generation,
            scope: self.inner.config.scope.clone(),
            access_sequence: candidate.access_sequence,
            total_bytes: candidate.total_bytes,
            entries: candidate.entries.clone(),
            index_sha256: String::new(),
        };
        let bytes = encode_index(&mut index)?;
        io::atomic_write(
            &self.inner.config.directory,
            &file_name,
            &bytes,
            cancellation,
        )?;
        candidate.active_index_file = Some(file_name);
        candidate.fallback_index_file = previous_index;
        candidate.fallback_record_files = previous_records;
        candidate.dirty_access = false;
        **active = candidate;
        Ok(())
    }

    pub(super) fn lock_state(&self) -> Result<MutexGuard<'_, CacheState>, ShaderDiskCacheError> {
        self.inner.state.lock().map_err(|_| {
            ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::LockPoisoned,
                "shader disk cache state lock is poisoned",
            )
        })
    }
}
