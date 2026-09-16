//! P1-08 第一批:GlyphRasterCache(真实栅格化 + 有界 LRU)与 GlyphAtlasBook
//! 的 place_text/resource_revision 对接。所有断言基于真实 cosmic-text 栅格化,
//! 计数器(hits/misses/evictions/revision)即"免重栅格"的证据。
#![cfg(target_os = "windows")]
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use deep_engine_native::platform_text::glyph_atlas::{AtlasSpec, GlyphAtlasBook};
use deep_engine_native::platform_text::raster::{
    CachedTextRequest, GLYPH_CACHE_MAX_BYTES, GlyphRasterCache,
};
use deep_engine_native::platform_text::{RasterizedText, TextRasterizer};

fn rasterizer() -> MutexGuard<'static, TextRasterizer> {
    static RASTERIZER: OnceLock<Mutex<TextRasterizer>> = OnceLock::new();
    RASTERIZER
        .get_or_init(|| Mutex::new(TextRasterizer::new()))
        .lock()
        .unwrap()
}

fn request(text: &str) -> CachedTextRequest<'_> {
    CachedTextRequest {
        text,
        family: "Microsoft YaHei",
        font_size: 16.0,
        line_height: 24.0,
        color: [50, 130, 210, 200],
    }
}

fn visible_pixels(raster: &RasterizedText) -> usize {
    raster
        .rgba
        .chunks_exact(4)
        .filter(|pixel| pixel[3] > 0)
        .count()
}

/// RasterizedText has no PartialEq; equality here means identical pixels and
/// identical layout metadata (the deterministic-rasterization contract).
fn assert_same_raster(a: &RasterizedText, b: &RasterizedText) {
    assert_eq!(
        (a.width, a.height, a.glyph_count, a.line_count),
        (b.width, b.height, b.glyph_count, b.line_count)
    );
    assert_eq!(a.rgba, b.rgba);
}

#[path = "glyph_cache/atlas_tests.rs"]
mod atlas;
#[path = "glyph_cache/cache_tests.rs"]
mod cache;
