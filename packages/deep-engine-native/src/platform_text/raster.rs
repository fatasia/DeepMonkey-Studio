//! Real shaping and font rasterization; callers supply colors and viewport limits.
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use cosmic_text::{Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache};

pub struct TextRasterizer {
    fonts: FontSystem,
    cache: SwashCache,
}

pub struct TextRasterRequest<'a> {
    pub text: &'a str,
    pub family: &'a str,
    pub font_size: f32,
    pub line_height: f32,
    pub width: u32,
    pub height: u32,
    pub color: [u8; 4],
}

#[derive(Debug)]
pub struct RasterizedText {
    pub width: u32,
    pub height: u32,
    /// Straight-alpha RGBA8, ready for the existing Deep2D image/atlas path.
    pub rgba: Vec<u8>,
    pub glyph_count: usize,
    pub line_count: usize,
}

impl Default for TextRasterizer {
    fn default() -> Self {
        Self::new()
    }
}
impl TextRasterizer {
    pub fn new() -> Self {
        Self {
            fonts: FontSystem::new(),
            cache: SwashCache::new(),
        }
    }

    /// P1-19:探测本机字体能力矩阵(身份 hash / 来源 / 许可状态)。
    ///
    /// 这是「运行时恰好装了什么」到「可冻结、可审计的身份」的唯一入口;
    /// 报告按内容 hash 稳定排序,可跨机器比对。
    pub fn font_capability(&mut self) -> super::font_capability::FontCapabilityReport {
        super::font_capability::capability_report(&mut self.fonts)
    }

    /// P1-19:指定家族是否存在于本机字体库(缺字诊断的对象级入口)。
    /// 不用成形结果判断——整形器会静默 fallback(见 `font_capability` 模块说明)。
    pub fn family_exists(&mut self, family: &str) -> bool {
        super::font_capability::family_exists(&mut self.fonts, family)
    }

    /// 单行自然宽度(逻辑像素,含字距);不设视口、不换行,供省略截断做真实测量。
    pub fn measure(
        &mut self,
        text: &str,
        family: &str,
        font_size: f32,
        line_height: f32,
    ) -> Result<f32, String> {
        if text.len() > 16_384
            || family.len() > 256
            || !font_size.is_finite()
            || !(1.0..=256.0).contains(&font_size)
            || !line_height.is_finite()
            || !(1.0..=512.0).contains(&line_height)
        {
            return Err("text measure request exceeds text or metric limits".into());
        }
        let mut buffer = Buffer::new(&mut self.fonts, Metrics::new(font_size, line_height));
        let attrs = Attrs::new().family(if family.is_empty() {
            Family::SansSerif
        } else {
            Family::Name(family)
        });
        buffer.set_text(text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.fonts, false);
        let mut max_advance = 0.0f32;
        for run in buffer.layout_runs() {
            let mut end = 0.0f32;
            for glyph in run.glyphs {
                if glyph.glyph_id == 0 {
                    return Err("installed fonts cannot render a requested glyph".into());
                }
                end = end.max(glyph.x + glyph.w);
            }
            max_advance = max_advance.max(end);
        }
        Ok(max_advance)
    }

    pub fn rasterize(&mut self, request: TextRasterRequest<'_>) -> Result<RasterizedText, String> {
        if request.width == 0
            || request.height == 0
            || request.width > 2048
            || request.height > 2048
            || request.text.len() > 16_384
            || request.family.len() > 256
            || !request.font_size.is_finite()
            || !(1.0..=256.0).contains(&request.font_size)
            || !request.line_height.is_finite()
            || !(1.0..=512.0).contains(&request.line_height)
        {
            return Err("text raster request exceeds viewport, text or metric limits".into());
        }
        let mut buffer = Buffer::new(
            &mut self.fonts,
            Metrics::new(request.font_size, request.line_height),
        );
        buffer.set_size(Some(request.width as f32), Some(request.height as f32));
        let attrs = Attrs::new().family(if request.family.is_empty() {
            Family::SansSerif
        } else {
            Family::Name(request.family)
        });
        buffer.set_text(request.text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.fonts, false);
        let mut glyph_count = 0;
        let mut line_count = 0;
        for run in buffer.layout_runs() {
            line_count += 1;
            for glyph in run.glyphs {
                if glyph.glyph_id == 0 {
                    return Err("installed fonts cannot render a requested glyph".into());
                }
                glyph_count += 1;
            }
        }
        // Bound the raster cache across unrelated labels; CPU font discovery is retained.
        if self.cache.image_cache.len() > 4096 {
            self.cache = SwashCache::new();
        }
        let mut rgba = vec![0; request.width as usize * request.height as usize * 4];
        let [r, g, b, a] = request.color;
        buffer.draw(
            &mut self.fonts,
            &mut self.cache,
            Color::rgba(r, g, b, a),
            |x, y, w, h, color| {
                let left = i64::from(x).max(0);
                let top = i64::from(y).max(0);
                let right = (i64::from(x) + i64::from(w)).min(i64::from(request.width));
                let bottom = (i64::from(y) + i64::from(h)).min(i64::from(request.height));
                for py in top..bottom {
                    for px in left..right {
                        let offset = (py as usize * request.width as usize + px as usize) * 4;
                        blend(
                            &mut rgba[offset..offset + 4],
                            [color.r(), color.g(), color.b(), color.a()],
                        );
                    }
                }
            },
        );
        Ok(RasterizedText {
            width: request.width,
            height: request.height,
            rgba,
            glyph_count,
            line_count,
        })
    }
}

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

fn blend(destination: &mut [u8], source: [u8; 4]) {
    let alpha = u32::from(source[3]);
    let inverse = 255 - alpha;
    let out_alpha = alpha * 255 + u32::from(destination[3]) * inverse;
    if out_alpha == 0 {
        return;
    }
    for channel in 0..3 {
        let numerator = u32::from(source[channel]) * alpha * 255
            + u32::from(destination[channel]) * u32::from(destination[3]) * inverse;
        destination[channel] = ((numerator + out_alpha / 2) / out_alpha) as u8;
    }
    destination[3] = ((out_alpha + 127) / 255) as u8;
}
