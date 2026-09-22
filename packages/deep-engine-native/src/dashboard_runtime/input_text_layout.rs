use super::*;
use crate::platform_text::*;
use unicode_segmentation::UnicodeSegmentation;

impl DashboardRuntime {
    pub(super) fn input_request(&self, text: String) -> Result<StyledTextRequest, String> {
        let input = self.input_profile().ok_or("input profile absent")?;
        Ok(StyledTextRequest {
            text,
            font: FrozenFontRef {
                sha256: input.fonts[0].sha256.clone(),
                face_index: input.fonts[0].face_index,
            },
            weight: input.style.font_weight,
            style: input.style.font_style,
            align: TextAlign::Left,
            vertical_align: TextVerticalAlign::Center,
            wrap: TextWrap::None,
            font_size: input.style.font_size,
            line_height: input.style.line_height,
            width: 2048,
            height: 32,
            color: input.style.color,
        })
    }
    pub(super) fn input_width(&self, value: &str) -> Result<f64, String> {
        if value.is_empty() {
            return Ok(0.0);
        }
        let request = self.input_request(value.into())?;
        let mut fonts = self
            .input_fonts
            .as_ref()
            .ok_or("input fonts absent")?
            .lock()
            .map_err(|_| "input font lock poisoned")?;
        Ok(f64::from(fonts.rasterize_styled(request)?.layout_width))
    }
    pub fn input_caret_rect(&self) -> Result<Option<[f64; 4]>, String> {
        let Some(node) = self.input_node().filter(|_| self.input_focused()) else {
            return Ok(None);
        };
        let prefix = format!(
            "{}{}",
            &self.input_ui.editor.document[..self.input_ui.editor.caret],
            self.input_ui.preedit
        );
        let caret = self.input_width(&prefix)?;
        let scroll = (caret - (node.frame[2] - 34.0) + 12.0).max(0.0);
        Ok(Some([
            node.frame[0] + 21.0 + caret - scroll,
            node.frame[1] + 22.0,
            1.0,
            22.0,
        ]))
    }
    pub(super) fn input_caret_at(&self, x: f64) -> Result<usize, String> {
        let node = self.input_node().ok_or("input node absent")?;
        let value = &self.input_ui.editor.document;
        let caret = self.input_width(&value[..self.input_ui.editor.caret])?;
        let scroll = (caret - (node.frame[2] - 34.0) + 12.0).max(0.0);
        let target = x - node.frame[0] - 21.0 + scroll;
        let boundaries: Vec<_> = value
            .grapheme_indices(true)
            .map(|(index, _)| index)
            .chain(std::iter::once(value.len()))
            .collect();
        let (mut left, mut right) = (0, boundaries.len() - 1);
        while left < right {
            let mid = (left + right) / 2;
            let a = self.input_width(&value[..boundaries[mid]])?;
            let b = self.input_width(&value[..boundaries[mid + 1]])?;
            if target < (a + b) * 0.5 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        Ok(boundaries[left])
    }
}
