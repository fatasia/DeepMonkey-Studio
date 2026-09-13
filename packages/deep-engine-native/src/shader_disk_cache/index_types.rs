use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::types::{CacheIndexEntry, ShaderDiskCacheScope};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CacheIndex {
    pub schema: String,
    pub schema_version: u32,
    pub generation: u64,
    pub scope: ShaderDiskCacheScope,
    pub access_sequence: u64,
    pub total_bytes: u64,
    pub entries: BTreeMap<String, CacheIndexEntry>,
    pub index_sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CacheState {
    pub generation: u64,
    pub active_index_file: Option<String>,
    pub fallback_index_file: Option<String>,
    pub fallback_record_files: BTreeSet<String>,
    pub access_sequence: u64,
    pub total_bytes: u64,
    pub entries: BTreeMap<String, CacheIndexEntry>,
    pub dirty_access: bool,
}

impl CacheState {
    pub fn empty() -> Self {
        Self {
            generation: 0,
            active_index_file: None,
            fallback_index_file: None,
            fallback_record_files: BTreeSet::new(),
            access_sequence: 0,
            total_bytes: 0,
            entries: BTreeMap::new(),
            dirty_access: false,
        }
    }

    pub fn next_access_sequence(&mut self) -> u64 {
        if self.access_sequence == u64::MAX {
            let mut ordered: Vec<_> = self.entries.iter_mut().collect();
            ordered.sort_by_key(|(key, entry)| (entry.access_sequence, (*key).clone()));
            for (index, (_, entry)) in ordered.into_iter().enumerate() {
                entry.access_sequence = index as u64 + 1;
            }
            self.access_sequence = self.entries.len() as u64;
        }
        self.access_sequence += 1;
        self.access_sequence
    }
}
