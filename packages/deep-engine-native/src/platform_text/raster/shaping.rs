use super::{RasterizedText, TextRasterRequest, TextRasterizer};
use cosmic_text::{Attrs, Buffer, Color, Family, Metrics, Shaping, SwashCache};

impl TextRasterizer {
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

pub(super) fn blend(destination: &mut [u8], source: [u8; 4]) {
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
