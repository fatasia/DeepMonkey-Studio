use super::{RasterizedText, TextRasterRequest, TextRasterizer};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

/// Cache key: every input baked into the pixels. Sizes carry IEEE bits so a
/// different font_size is always a different key (尺寸变化明确全重建), and
/// color is part of the key because rasterize blends it into the output.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TextRasterKey {
    pub family: String,
    pub font_size_bits: u32,
    pub line_height_bits: u32,
    pub color: [u8; 4],
    pub text: String,
}

impl TextRasterKey {
    pub fn new(text: &str, family: &str, font_size: f32, line_height: f32, color: [u8; 4]) -> Self {
        Self {
            family: family.to_string(),
            font_size_bits: font_size.to_bits(),
            line_height_bits: line_height.to_bits(),
            color,
            text: text.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GlyphCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub entries: usize,
    pub payload_bytes: usize,
}

/// Cache-facing request: the cache derives the raster viewport from a real
/// `measure`, so identical text always yields identical pixels and the key
/// stays (family, size, color, text) — viewport never splits one text.
pub struct CachedTextRequest<'a> {
    pub text: &'a str,
    pub family: &'a str,
    pub font_size: f32,
    pub line_height: f32,
    pub color: [u8; 4],
}

pub const GLYPH_CACHE_MAX_ENTRIES: usize = 4096;
pub const GLYPH_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_RASTER_DIMENSION: u32 = 2048;

struct GlyphCacheEntry {
    raster: Arc<RasterizedText>,
    bytes: usize,
    touched: u64,
}

/// Bounded LRU over real rasterized text, accounting style aligned with the
/// deep2d path cache: entry-count + payload-bytes dual budget. Hits never
/// re-rasterize; evicted entries re-rasterize on the next request (correctness
/// over caching). Values are Arc-shared, so eviction or `clear` never mutates
/// what a caller still holds.
pub struct GlyphRasterCache {
    entries: HashMap<TextRasterKey, GlyphCacheEntry>,
    order: BTreeSet<(u64, TextRasterKey)>,
    stats: GlyphCacheStats,
    tick: u64,
    max_entries: usize,
    max_bytes: usize,
    revision: u64,
}

impl Default for GlyphRasterCache {
    fn default() -> Self {
        Self::new()
    }
}

impl GlyphRasterCache {
    pub fn new() -> Self {
        Self::with_budgets(GLYPH_CACHE_MAX_ENTRIES, GLYPH_CACHE_MAX_BYTES)
    }

    pub fn with_budgets(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: BTreeSet::new(),
            stats: GlyphCacheStats::default(),
            tick: 0,
            max_entries,
            max_bytes,
            revision: 0,
        }
    }

    pub fn stats(&self) -> GlyphCacheStats {
        self.stats
    }

    /// Content-change counter (resource-set epoch seam for P1-01): insert,
    /// evict and clear advance it; hits do not.
    pub fn resource_revision(&self) -> u64 {
        self.revision
    }

    pub fn get(&mut self, key: &TextRasterKey) -> Option<Arc<RasterizedText>> {
        if !self.entries.contains_key(key) {
            return None;
        }
        self.tick = self.tick.saturating_add(1);
        let entry = self.entries.get_mut(key).unwrap();
        self.order.remove(&(entry.touched, key.clone()));
        entry.touched = self.tick;
        self.order.insert((entry.touched, key.clone()));
        self.stats.hits += 1;
        Some(entry.raster.clone())
    }

    pub fn rasterize(
        &mut self,
        rasterizer: &mut TextRasterizer,
        request: CachedTextRequest<'_>,
    ) -> Result<Arc<RasterizedText>, String> {
        let key = TextRasterKey::new(
            request.text,
            request.family,
            request.font_size,
            request.line_height,
            request.color,
        );
        if let Some(hit) = self.get(&key) {
            return Ok(hit);
        }
        self.stats.misses += 1;
        self.tick = self.tick.saturating_add(1);
        // Raster failures never enter the cache: the next request retries.
        let measured = rasterizer.measure(
            request.text,
            request.family,
            request.font_size,
            request.line_height,
        )?;
        if !measured.is_finite() || measured > MAX_RASTER_DIMENSION as f32 {
            return Err("text raster width exceeds the 2048px viewport limit".into());
        }
        let width = measured.ceil().clamp(1.0, MAX_RASTER_DIMENSION as f32) as u32;
        let height = (request.line_height.ceil() as u32).clamp(1, MAX_RASTER_DIMENSION);
        let raster = Arc::new(rasterizer.rasterize(TextRasterRequest {
            text: request.text,
            family: request.family,
            font_size: request.font_size,
            line_height: request.line_height,
            width,
            height,
            color: request.color,
        })?);
        self.store(key, raster.clone());
        Ok(raster)
    }

    /// Clears all entries. Arc values already handed out stay valid untouched.
    pub fn clear(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        self.entries.clear();
        self.order.clear();
        self.stats.entries = 0;
        self.stats.payload_bytes = 0;
        self.revision = self.revision.saturating_add(1);
    }

    fn store(&mut self, key: TextRasterKey, raster: Arc<RasterizedText>) {
        let bytes = raster.rgba.len()
            + key.text.len()
            + key.family.len()
            + std::mem::size_of::<GlyphCacheEntry>();
        // Oversized or uncachable: the value was already produced, so return it
        // uncached instead of failing (correctness first).
        if bytes > self.max_bytes || self.max_entries == 0 {
            return;
        }
        while self.entries.len() >= self.max_entries
            || self.stats.payload_bytes + bytes > self.max_bytes
        {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            let old = self.entries.remove(&oldest).unwrap();
            self.stats.payload_bytes -= old.bytes;
            self.stats.evictions += 1;
            self.revision = self.revision.saturating_add(1);
        }
        self.stats.payload_bytes += bytes;
        self.order.insert((self.tick, key.clone()));
        self.entries.insert(
            key,
            GlyphCacheEntry {
                raster,
                bytes,
                touched: self.tick,
            },
        );
        self.stats.entries = self.entries.len();
        self.revision = self.revision.saturating_add(1);
    }
}
