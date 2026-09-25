use super::*;
use unicode_segmentation::UnicodeSegmentation;

impl DashboardRuntime {
    pub fn input_selected_text(&self) -> Option<&str> {
        self.input_ui
            .editor
            .selection()
            .filter(|(a, b)| a != b)
            .map(|(a, b)| &self.input_ui.editor.document[a..b])
    }
    pub fn input_composing(&self) -> bool {
        self.input_ui.ime.composing()
    }
    pub fn input_paste(&mut self, text: &str) -> Result<bool, String> {
        if !self.input_focused() || self.input_composing() {
            return Ok(false);
        }
        // HTML single-line input strips CR/LF rather than inserting paragraphs.
        let text: String = text.chars().filter(|c| !matches!(c, '\r' | '\n')).collect();
        self.input_key("Paste", Some(&text), false, false)
    }
    pub fn input_cut_selection(&mut self) -> Result<bool, String> {
        if self.input_selected_text().is_none() {
            return Ok(false);
        }
        self.input_key("Delete", None, false, false)
    }
    pub fn input_pointer_select(
        &mut self,
        point: Option<[f64; 2]>,
        extend: bool,
        word: bool,
    ) -> Result<bool, String> {
        if let Some(id) = point.and_then(|p| self.input_id_at(p))
            && self.active_input.as_ref() != Some(&id)
        {
            return self.transaction(|candidate| {
                candidate.activate_input(&id)?;
                candidate.input_pointer_select(point, extend, word)
            });
        }
        let Some(node) = self.input_node() else {
            return Ok(false);
        };
        let [x, y, w, _] = node.frame;
        let Some(point) = point.filter(|p| {
            p[0] >= x + 17.0 && p[0] < x + w - 17.0 && p[1] >= y + 17.0 && p[1] < y + 49.0
        }) else {
            return self.input_focus(false);
        };
        let caret = self.input_caret_at(point[0])?;
        self.transaction(|next| {
            let editor = &mut next.input_ui.editor;
            if word {
                let (start, end) = word_at(&editor.document, caret);
                editor.anchor = Some(start);
                editor.caret = end;
            } else {
                editor.anchor = if extend {
                    Some(editor.anchor.unwrap_or(editor.caret))
                } else {
                    None
                };
                editor.caret = caret;
            }
            next.select_ui.focused = false;
            next.select_ui.open = false;
            next.focus_id = next.active_input.clone();
            next.input_ui.focused = true;
            next.input_ui.ime = crate::platform_text::WinitImeAdapter::new();
            next.input_ui.preedit.clear();
            Ok(true)
        })
    }
    pub fn input_drag_selection(&mut self, x: f64, anchor: usize) -> Result<bool, String> {
        if !self.input_focused() || self.input_composing() {
            return Ok(false);
        }
        let caret = self.input_caret_at(x)?;
        if caret == self.input_ui.editor.caret && self.input_ui.editor.anchor == Some(anchor) {
            return Ok(false);
        }
        let document = &self.input_ui.editor.document;
        if anchor != document.len()
            && !document
                .grapheme_indices(true)
                .any(|(index, _)| index == anchor)
        {
            return Err("invalid input drag anchor".into());
        }
        self.transaction(|next| {
            next.input_ui.editor.anchor = Some(anchor);
            next.input_ui.editor.caret = caret;
            Ok(true)
        })
    }
    pub fn input_selection_anchor(&self) -> usize {
        self.input_ui
            .editor
            .anchor
            .unwrap_or(self.input_ui.editor.caret)
    }
}

fn word_at(text: &str, caret: usize) -> (usize, usize) {
    text.split_word_bound_indices()
        .find(|(start, word)| *start <= caret && caret < start + word.len())
        .or_else(|| text.split_word_bound_indices().next_back())
        .map(|(start, word)| (start, start + word.len()))
        .unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn double_click_uses_unicode_word_boundaries() {
        assert_eq!(word_at("East West", 2), (0, 4));
        assert_eq!(word_at("East West", 9), (5, 9));
        let text = "e\u{301} 🙂";
        assert_eq!(word_at(text, 0), (0, 3));
        let (start, end) = word_at(text, 4);
        assert_eq!(&text[start..end], "🙂");
    }
}
