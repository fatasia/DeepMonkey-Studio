//! Real shaping and font rasterization; callers supply colors and viewport limits.
use cosmic_text::{FontSystem, SwashCache};

mod frozen_fonts;
mod glyph_cache;
mod measure;
mod measure_atlas;
mod profile;
mod scaled;
#[cfg(test)]
mod scaled_tests;
mod shaping;
mod styled;
mod styled_types;
pub use frozen_fonts::{FrozenTextRasterizer, runtime_text_rasterizer};
#[cfg(target_arch = "wasm32")]
pub use frozen_fonts::{add_runtime_font, clear_runtime_fonts};
pub use measure::{
    GLYPH_MEASURE_MAX_ATLAS_DIMENSION, GLYPH_MEASURE_MAX_CELLS, GLYPH_MEASURE_MAX_LINES,
    GlyphMeasureLine, GlyphMeasureRequest, MeasuredGlyphLine, MeasuredGlyphPlacement,
    MeasuredGlyphRun,
};
pub use profile::TextRasterProfile;
pub use styled_types::*;
#[cfg(test)]
mod frozen_tests;
#[cfg(test)]
mod measure_tests;

pub use glyph_cache::{
    CachedTextRequest, GLYPH_CACHE_MAX_BYTES, GLYPH_CACHE_MAX_ENTRIES, GlyphCacheStats,
    GlyphRasterCache, TextRasterKey,
};

pub struct TextRasterizer {
    fonts: FontSystem,
    cache: SwashCache,
    profile: Option<TextRasterProfile>,
    display_scale: f32,
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
            profile: None,
            display_scale: 1.0,
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

    /// P1-19 探针复用:这段文字按当前系统整体字体能力成形时是否零 `.notdef`。
    /// 图表轴/图例在光栅化前用它拦截缺字,按 fail-closed 语义报错而不是画方框。
    pub fn shapes_without_missing_glyphs(&mut self, family: &str, text: &str) -> bool {
        let started = self.profile.as_ref().map(|_| web_time::Instant::now());
        let result = super::font_capability::text_shapes_without_missing_glyphs(
            &mut self.fonts,
            family,
            text,
        );
        if let (Some(started), Some(profile)) = (started, &mut self.profile) {
            profile.glyph_probe_calls += 1;
            profile.glyph_probe_nanos += started.elapsed().as_nanos();
        }
        result
    }
}

#[cfg(all(test, target_os = "windows"))]
mod frozen_windows_tests;
