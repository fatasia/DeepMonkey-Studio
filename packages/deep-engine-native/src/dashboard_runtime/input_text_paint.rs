use super::*;
use crate::{
    deep2d::*,
    native_ui::{ControlCanvas, ControlPalette},
    platform_text::*,
};
impl DashboardRuntime {
    pub(super) fn input_content(&self) -> Result<Option<Deep2dRuntimeContent>, String> {
        let Some(node) = self.input_node() else {
            return Ok(None);
        };
        let input = self.input_profile().unwrap();
        let width = node.frame[2] - 34.0;
        let mut text = self
            .input_fonts
            .as_ref()
            .ok_or("input fonts absent")?
            .lock()
            .map_err(|_| "input font lock poisoned")?;
        let mut displayed = self.input_ui.editor.document.clone();
        displayed.insert_str(self.input_ui.editor.caret, &self.input_ui.preedit);
        let request = |value: String| StyledTextRequest {
            text: value,
            font: FrozenFontRef {
                sha256: input.fonts[0].sha256.clone(),
                face_index: input.fonts[0].face_index,
            },
            weight: input.style.font_weight,
            style: input.style.font_style,
            align: crate::platform_text::TextAlign::Left,
            vertical_align: TextVerticalAlign::Center,
            wrap: TextWrap::None,
            font_size: input.style.font_size,
            line_height: input.style.line_height,
            width: 2048,
            height: 32,
            color: input.style.color,
        };
        let pixels = text.rasterize_styled(request(displayed.clone()))?;
        if pixels.clipped {
            return Err("input text exceeds raster extent".into());
        }
        let prefix = format!(
            "{}{}",
            &self.input_ui.editor.document[..self.input_ui.editor.caret],
            self.input_ui.preedit
        );
        let caret = if prefix.is_empty() {
            0.0
        } else {
            f64::from(text.rasterize_styled(request(prefix))?.layout_width)
        };
        let scroll = (caret - width + 12.0).max(0.0);
        let palette = ControlPalette::dark();
        let mut canvas = ControlCanvas::new();
        canvas.fill_rect(
            "input-surface",
            [17.0, 17.0, width, 32.0],
            palette.surface,
            3.0,
            1.0,
        );
        if self.input_focused() {
            canvas.fill_rect(
                "input-caret",
                [21.0 + caret - scroll, 22.0, 1.0, 22.0],
                palette.line,
                0.0,
                1.0,
            );
            if let Some((start, end)) = self.input_ui.editor.selection() {
                let measure =
                    |value: &str, raster: &mut FrozenTextRasterizer| -> Result<f64, String> {
                        Ok(if value.is_empty() {
                            0.0
                        } else {
                            f64::from(raster.rasterize_styled(request(value.into()))?.layout_width)
                        })
                    };
                let left = measure(&self.input_ui.editor.document[..start], &mut text)?;
                let right = measure(&self.input_ui.editor.document[..end], &mut text)?;
                canvas.fill_rect(
                    "input-selection",
                    [21.0 + left - scroll, 20.0, right - left, 26.0],
                    palette.accent,
                    0.0,
                    0.35,
                );
            }
        }
        let mut list = RasterizedText {
            width: pixels.width,
            height: pixels.height,
            rgba: pixels.rgba,
            glyph_count: pixels.glyph_count,
            line_count: pixels.line_count,
        }
        .into_display_list(
            &format!("dashboard-input-text.{}", node.id),
            self.revision,
            [node.frame[2], node.frame[3]],
            [21.0 - scroll, 17.0],
            5,
        )?;
        let chrome = canvas.into_display_list(node.frame[2], node.frame[3]);
        list.commands.extend(chrome.commands);
        list.resources.extend(chrome.resources);
        for command in &mut list.commands {
            match command {
                Deep2dCommand::Image(image) => {
                    image.clip_rect = Some(Deep2dRect {
                        x: 17.0,
                        y: 17.0,
                        width,
                        height: 32.0,
                    })
                }
                Deep2dCommand::Path(path) => {
                    path.clip_rect = Some(Deep2dRect {
                        x: 17.0,
                        y: 17.0,
                        width,
                        height: 32.0,
                    })
                }
                _ => {}
            }
        }
        Ok(Some(Deep2dRuntimeContent::DisplayList(list)))
    }
}
