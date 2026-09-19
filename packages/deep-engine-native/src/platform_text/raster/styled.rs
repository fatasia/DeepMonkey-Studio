use super::{FrozenTextRasterizer, styled_types::*};
use cosmic_text::{
    Align, Attrs, Buffer, Color, Family, Metrics, Shaping, Style, Weight, Wrap,
};
use std::collections::{BTreeSet, HashSet};
impl FrozenTextRasterizer {
    pub fn rasterize_styled(
        &mut self,
        request: StyledTextRequest,
    ) -> Result<StyledRasterizedText, String> {
        validate(&request)?;
        let family = self.primary(&request)?.family.clone();
        let style = match request.style {
            TextFontStyle::Normal => Style::Normal,
            TextFontStyle::Italic => Style::Italic,
            TextFontStyle::Oblique => Style::Oblique,
        };
        let align = match request.align {
            TextAlign::Left => Align::Left,
            TextAlign::Center => Align::Center,
            TextAlign::Right => Align::Right,
        };
        let wrap = match request.wrap {
            TextWrap::None => Wrap::None,
            TextWrap::Word => Wrap::Word,
            TextWrap::Glyph => Wrap::Glyph,
            TextWrap::WordOrGlyph => Wrap::WordOrGlyph,
        };
        let attrs = Attrs::new()
            .family(Family::Name(&family))
            .weight(Weight(request.weight))
            .style(style);
        let mut buffer = Buffer::new(
            &mut self.inner.fonts,
            Metrics::new(request.font_size, request.line_height),
        );
        // Infinite layout height checks all text, including missing glyphs below the output viewport.
        buffer.set_size(Some(request.width as f32), None);
        buffer.set_wrap(wrap);
        buffer.set_text(&request.text, &attrs, Shaping::Advanced, Some(align));
        buffer.shape_until_scroll(&mut self.inner.fonts, false);
        let mut lines = Vec::new();
        let mut used = BTreeSet::new();
        let mut glyph_count = 0usize;
        let mut layout_width = 0f32;
        let mut layout_height = 0f32;

        for run in buffer.layout_runs() {
            if lines.len() >= 16_384 {
                return Err("styled text line budget exceeded".into());
            }
            layout_width = layout_width.max(run.line_w);
            layout_height = layout_height.max(run.line_top + run.line_height);
            lines.push(TextLayoutLine {
                line_index: run.line_i,
                baseline: run.line_y,
                top: run.line_top,
                height: run.line_height,
                width: run.line_w,
            });
            for glyph in run.glyphs {
                glyph_count += 1;
                if glyph_count > 65_536 {
                    return Err("styled text glyph budget exceeded".into());
                }
                if glyph.glyph_id == 0 {
                    return Err(format!(
                        "frozen fonts cannot render glyph at line {} bytes {}..{}",
                        run.line_i, glyph.start, glyph.end
                    ));
                }
                let face = self
                    .identities
                    .get(&glyph.font_id)
                    .ok_or("shaper selected an unfrozen font face")?;
                if face.weight != request.weight || face.style != request.style {
                    return Err("fallback face does not implement requested weight/style".into());
                }
                used.insert(glyph.font_id);
            }
        }
        // Validate every run before rasterizing any glyph (including offscreen text).
        let mut sample_budget = 0u64;
        let mut raster_bytes = 0usize;
        // Reuse shared glyphs between batched labels, but never retain unrelated glyphs indefinitely.
        let needed: HashSet<_> = buffer.layout_runs().flat_map(|run| run.glyphs.iter()
            .map(move |glyph| glyph.physical((0., run.line_y), 1.).cache_key)).collect();
        self.inner.cache.image_cache.retain(|key, _| needed.contains(key));
        let mut resident_bytes: usize = self.inner.cache.image_cache.values().flatten().map(|image| image.data.len()).sum();
        for run in buffer.layout_runs() {
            for glyph in run.glyphs {
                let physical = glyph.physical((0., run.line_y), 1.);
                let cached = self.inner.cache.image_cache.contains_key(&physical.cache_key);
                if let Some(image) = self
                    .inner
                    .cache
                    .get_image(&mut self.inner.fonts, physical.cache_key)
                {
                    sample_budget = sample_budget.saturating_add(
                        u64::from(image.placement.width) * u64::from(image.placement.height),
                    );
                    raster_bytes = raster_bytes.saturating_add(image.data.len());
                    if !cached { resident_bytes = resident_bytes.saturating_add(image.data.len()); }
                    if resident_bytes > 64 * 1024 * 1024 || raster_bytes > 64 * 1024 * 1024 || sample_budget > 64 * 1024 * 1024 {
                        return Err("styled glyph raster work exceeds 64 Mi pixels".into());
                    }
                }
            }
        }
        let ratio = match request.vertical_align {
            TextVerticalAlign::Top => 0.0,
            TextVerticalAlign::Center => 0.5,
            TextVerticalAlign::Bottom => 1.0,
        };
        let vertical_offset = (request.height as f32 - layout_height).max(0.0) * ratio;
        for line in &mut lines {
            line.baseline += vertical_offset;
            line.top += vertical_offset;
        }
        // Quantize translation once: rounding each signed pixel separately would
        // tear a glyph across y=0 when the logical offset is half a pixel.
        let pixel_offset = vertical_offset.round() as i64;
        let mut rgba = vec![0; request.width as usize * request.height as usize * 4];
        let mut clipped = layout_width > request.width as f32
            || layout_height + vertical_offset > request.height as f32;
        let mut ink = None;
        let [r, g, b, a] = request.color;
        buffer.draw(
            &mut self.inner.fonts,
            &mut self.inner.cache,
            Color::rgba(r, g, b, a),
            |x, y, w, h, color| {
                // Raster samples are integral pixels; reported layout retains logical precision.
                let y = i64::from(y) + pixel_offset;
                if color.a() == 0 {
                    return;
                }
                let right = i64::from(x) + i64::from(w);
                let bottom = y + i64::from(h);
                if x < 0
                    || y < 0
                    || right > i64::from(request.width)
                    || bottom > i64::from(request.height)
                {
                    clipped = true;
                }
                for py in y.max(0)..bottom.min(i64::from(request.height)) {
                    for px in i64::from(x).max(0)..right.min(i64::from(request.width)) {
                        let offset = (py as usize * request.width as usize + px as usize) * 4;
                        super::shaping::blend(
                            &mut rgba[offset..offset + 4],
                            [color.r(), color.g(), color.b(), color.a()],
                        );
                        let bounds =
                            ink.get_or_insert([px as u32, py as u32, px as u32 + 1, py as u32 + 1]);
                        bounds[0] = bounds[0].min(px as u32);
                        bounds[1] = bounds[1].min(py as u32);
                        bounds[2] = bounds[2].max(px as u32 + 1);
                        bounds[3] = bounds[3].max(py as u32 + 1);
                    }
                }
            },
        );
        let mut used_faces: Vec<_> = used
            .into_iter()
            .map(|id| self.identities[&id].clone())
            .collect();
        used_faces.sort_by(|a, b| (&a.sha256, a.face_index).cmp(&(&b.sha256, b.face_index)));
        Ok(StyledRasterizedText {
            width: request.width,
            height: request.height,
            rgba,
            glyph_count,
            line_count: lines.len(),
            layout_width,
            layout_height,
            ink_bounds: ink,
            clipped,
            lines,
            used_faces,
        })
    }
}
fn validate(r: &StyledTextRequest) -> Result<(), String> {
    if r.width == 0
        || r.height == 0
        || r.width > 2048
        || r.height > 2048
        || r.text.len() > 16_384
        || !(1..=1000).contains(&r.weight)
        || !r.font_size.is_finite()
        || !(1.0..=256.0).contains(&r.font_size)
        || !r.line_height.is_finite()
        || !(1.0..=512.0).contains(&r.line_height)
    {
        return Err("styled text request exceeds text, viewport or metric limits".into());
    }
    Ok(())
}
