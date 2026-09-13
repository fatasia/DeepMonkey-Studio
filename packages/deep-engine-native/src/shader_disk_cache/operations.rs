use std::{collections::HashSet, sync::atomic::Ordering};

use crate::shader_package::DeepShaderPackageV2;

use super::{
    ShaderDiskCache, as_corrupt_record,
    format::{
        MAX_RECORD_BYTES, decode_record, encode_record, identity, logical_key, validate_package,
    },
    io,
    types::{
        CacheIndexEntry, ShaderDiskCacheCancellation, ShaderDiskCacheError,
        ShaderDiskCacheErrorCode,
    },
};

#[derive(Clone, Copy)]
enum PutFault {
    None,
    #[cfg(test)]
    BeforeIndexPublish,
}

impl ShaderDiskCache {
    pub fn put(
        &self,
        bytes: &[u8],
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<DeepShaderPackageV2, ShaderDiskCacheError> {
        self.put_internal(bytes, cancellation, PutFault::None)
    }

    pub fn get(
        &self,
        package_cache_key: &str,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<Option<DeepShaderPackageV2>, ShaderDiskCacheError> {
        io::check_cancel(cancellation)?;
        let cache_identity = identity(&self.inner.config.scope, package_cache_key)?;
        let key = logical_key(&cache_identity)?;
        let mut state = self.lock_state()?;
        let Some(entry) = state.entries.get(&key).cloned() else {
            return Ok(None);
        };
        let package = self.read_entry(&key, &entry, cancellation)?;
        let mut candidate = state.clone();
        let sequence = candidate.next_access_sequence();
        candidate
            .entries
            .get_mut(&key)
            .expect("entry cloned from active state")
            .access_sequence = sequence;
        candidate.dirty_access = true;
        *state = candidate;
        Ok(Some(package))
    }

    pub fn remove(
        &self,
        package_cache_key: &str,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<bool, ShaderDiskCacheError> {
        io::check_cancel(cancellation)?;
        let key = logical_key(&identity(&self.inner.config.scope, package_cache_key)?)?;
        let mut state = self.lock_state()?;
        let Some(removed) = state.entries.get(&key) else {
            return Ok(false);
        };
        let mut candidate = state.clone();
        candidate.total_bytes -= removed.byte_length;
        candidate.entries.remove(&key);
        self.publish(&mut state, candidate, cancellation)?;
        drop(state);
        let _ = self.cleanup(None);
        Ok(true)
    }

    pub fn clear(
        &self,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<(), ShaderDiskCacheError> {
        io::check_cancel(cancellation)?;
        let mut state = self.lock_state()?;
        if !state.entries.is_empty() {
            let mut candidate = state.clone();
            candidate.entries.clear();
            candidate.total_bytes = 0;
            self.publish(&mut state, candidate, cancellation)?;
        }
        drop(state);
        // The clear commit is already durable at this point. Cleanup is
        // reachability maintenance and must not turn a committed clear into
        // a reported cancellation if the token changes while it scans files.
        self.cleanup(None).map(|_| ())
    }

    pub fn cleanup(
        &self,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<usize, ShaderDiskCacheError> {
        let state = self.lock_state()?;
        let mut retained = HashSet::new();
        if let Some(name) = &state.active_index_file {
            retained.insert(name.clone());
        }
        if let Some(name) = &state.fallback_index_file {
            retained.insert(name.clone());
        }
        retained.extend(state.fallback_record_files.iter().cloned());
        retained.extend(
            state
                .entries
                .values()
                .map(|entry| entry.record_file.clone()),
        );
        let mut removed = 0;
        for (name, path) in io::list_files(&self.inner.config.directory)? {
            io::check_cancel(cancellation)?;
            if io::owned_file(&name) && !retained.contains(&name) {
                io::remove_file(&path)?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    fn put_internal(
        &self,
        bytes: &[u8],
        cancellation: Option<&ShaderDiskCacheCancellation>,
        _fault: PutFault,
    ) -> Result<DeepShaderPackageV2, ShaderDiskCacheError> {
        io::check_cancel(cancellation)?;
        let package = validate_package(bytes, &self.inner.config.scope)?;
        let record_bytes = encode_record(&package, &self.inner.config.scope)?;
        if record_bytes.len() as u64 > self.inner.config.max_bytes
            || record_bytes.len() as u64 > MAX_RECORD_BYTES
        {
            return Err(ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::CapacityExceeded,
                "one shader package exceeds the disk cache byte budget",
            ));
        }
        let mut state = self.lock_state()?;
        if let Some(existing) = state.entries.get(&package.logical_key) {
            self.read_entry(&package.logical_key, existing, cancellation)?;
            if existing.package_sha256 != package.package_sha256 {
                return Err(ShaderDiskCacheError::new(
                    ShaderDiskCacheErrorCode::CorruptRecord,
                    "one package cache key resolved to different canonical content",
                ));
            }
            let sequence = state.next_access_sequence();
            state
                .entries
                .get_mut(&package.logical_key)
                .expect("existing cache entry")
                .access_sequence = sequence;
            state.dirty_access = true;
            self.inner.coalesced_writes.fetch_add(1, Ordering::AcqRel);
            return Ok(package.package);
        }
        let next_generation = state.generation.checked_add(1).ok_or_else(|| {
            ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::CorruptIndex,
                "shader cache generation overflowed",
            )
        })?;
        let record_name = io::record_file_name(
            &package.logical_key,
            &package.package_sha256,
            next_generation,
        );
        io::atomic_write(
            &self.inner.config.directory,
            &record_name,
            &record_bytes,
            cancellation,
        )?;
        self.inner
            .physical_record_writes
            .fetch_add(1, Ordering::AcqRel);
        #[cfg(test)]
        if matches!(_fault, PutFault::BeforeIndexPublish) {
            return Err(ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::Io,
                "injected failure before index publication",
            ));
        }
        let mut candidate = state.clone();
        let sequence = candidate.next_access_sequence();
        candidate.total_bytes += record_bytes.len() as u64;
        candidate.entries.insert(
            package.logical_key.clone(),
            CacheIndexEntry {
                record_file: record_name.clone(),
                byte_length: record_bytes.len() as u64,
                access_sequence: sequence,
                package_cache_key: package.package.package_cache_key.clone(),
                package_sha256: package.package_sha256.clone(),
            },
        );
        self.trim(&mut candidate);
        if let Err(failure) = self.publish(&mut state, candidate, cancellation) {
            let _ = io::remove_file(&self.inner.config.directory.join(record_name));
            return Err(failure);
        }
        drop(state);
        let _ = self.cleanup(None);
        Ok(package.package)
    }

    fn read_entry(
        &self,
        key: &str,
        entry: &CacheIndexEntry,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<DeepShaderPackageV2, ShaderDiskCacheError> {
        let bytes = io::read_owned_file(
            &self.inner.config.directory.join(&entry.record_file),
            MAX_RECORD_BYTES,
            cancellation,
        )
        .map_err(as_corrupt_record)?;
        if bytes.len() as u64 != entry.byte_length {
            return Err(ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::CorruptRecord,
                "shader cache record byte length changed",
            ));
        }
        decode_record(&bytes, &self.inner.config.scope, key, entry)
    }

    #[cfg(test)]
    pub(crate) fn put_failing_before_publish(
        &self,
        bytes: &[u8],
    ) -> Result<DeepShaderPackageV2, ShaderDiskCacheError> {
        self.put_internal(bytes, None, PutFault::BeforeIndexPublish)
    }
}
