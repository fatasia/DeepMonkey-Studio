//! Content hashing shared by caster preparation.
use std::{collections::HashMap, fmt::Write, hash::Hasher};

pub(super) struct HashWriter(std::collections::hash_map::DefaultHasher);

impl HashWriter {
    pub(super) fn new(domain: &[u8]) -> Self {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        hash.write(domain);
        Self(hash)
    }

    pub(super) fn geometry<'a>(
        &mut self,
        id: &'a str,
        resources: &HashMap<&str, &deep_engine_native::contract::GeometryResource>,
        include_uv0: bool,
        cache: &mut HashMap<&'a str, [Option<u64>; 2]>,
    ) -> Result<(), String> {
        let cached = &mut cache.entry(id).or_default()[usize::from(include_uv0)];
        if let Some(digest) = *cached {
            self.0.write_u64(digest);
            return Ok(());
        }
        let geometry = resources
            .get(id)
            .ok_or_else(|| format!("shadow caster geometry {id} is missing"))?;
        let mut digest = Self::new(b"native-shadow-geometry-v1");
        write!(
            &mut digest,
            "{}{:?}{:?}",
            geometry.id, geometry.vertices, geometry.indices
        )
        .unwrap();
        if include_uv0 {
            write!(&mut digest, "{:?}", geometry.uv0).unwrap();
        }
        let digest = digest.finish();
        *cached = Some(digest);
        self.0.write_u64(digest);
        Ok(())
    }

    pub(super) fn texture<'a>(
        &mut self,
        id: &'a str,
        resources: &HashMap<&str, &deep_engine_native::contract::TextureResource>,
        cache: &mut HashMap<&'a str, u64>,
    ) -> Result<(), String> {
        if let Some(&digest) = cache.get(id) {
            self.0.write_u64(digest);
            return Ok(());
        }
        let texture = resources
            .get(id)
            .ok_or_else(|| format!("shadow caster texture {id} is missing"))?;
        let mut digest = Self::new(b"native-shadow-texture-v1");
        write!(
            &mut digest,
            "{}{:?}{:?}{:?}{:?}{:?}{:?}{:?}",
            texture.id,
            texture.semantic,
            texture.width,
            texture.height,
            texture.data,
            texture.bytes_per_row,
            texture.mipmaps,
            texture.sampler
        )
        .unwrap();
        let digest = digest.finish();
        cache.insert(id, digest);
        self.0.write_u64(digest);
        Ok(())
    }

    pub(super) fn finish(self) -> u64 {
        self.0.finish()
    }
}

impl Write for HashWriter {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        self.0.write(text.as_bytes());
        Ok(())
    }
}
