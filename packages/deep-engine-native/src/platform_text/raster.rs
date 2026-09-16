//! Real shaping and font rasterization; callers supply colors and viewport limits.
use cosmic_text::{FontSystem, SwashCache};

mod frozen_fonts;
mod glyph_cache;
mod shaping;
mod styled;
mod styled_types;
pub use frozen_fonts::FrozenTextRasterizer;
pub use styled_types::*;
#[cfg(test)]
mod frozen_tests;

pub use glyph_cache::{
    CachedTextRequest, GLYPH_CACHE_MAX_BYTES, GLYPH_CACHE_MAX_ENTRIES, GlyphCacheStats,
    GlyphRasterCache, TextRasterKey,
};

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
}

#[cfg(all(test, target_os = "windows"))]
mod frozen_windows_tests;
