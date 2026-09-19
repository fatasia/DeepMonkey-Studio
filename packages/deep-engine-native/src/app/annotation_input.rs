//! Annotation editing uses the shared grapheme/IME transaction model.
use deep_engine_native::platform_text::{ImeSession, TextDocumentV1};
use unicode_segmentation::UnicodeSegmentation;
use winit::event::Ime;

pub(super) struct AnnotationEditor {
    session: ImeSession,
}
impl AnnotationEditor {
    pub(super) fn new(text: &str) -> Result<Self, String> {
        let document =
            TextDocumentV1::new(text, vec![], vec![], vec![]).map_err(|e| e.to_string())?;
        let caret = document.cluster_count();
        let mut session = ImeSession::new(document, 64);
        session.focus();
        session.set_caret(caret).map_err(|e| e.to_string())?;
        Ok(Self { session })
    }
    pub(super) fn text(&self) -> &str {
        self.session.document().text()
    }
    pub(super) fn preedit(&self) -> &str {
        self.session.pending()
    }
    pub(super) fn focus(&mut self, focused: bool) {
        if focused {
            self.session.focus();
        } else {
            self.session.blur();
        }
    }
    pub(super) fn backspace(&mut self) -> Result<(), String> {
        self.session
            .backspace()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub(super) fn append(&mut self, text: &str) -> Result<(), String> {
        if !self.session.is_focused() {
            return Err("annotation editor is not focused".into());
        }
        let filtered: String = text.chars().filter(|c| !c.is_control()).collect();
        let mut capacity = 256usize.saturating_sub(self.text().chars().count());
        let bounded: String = filtered
            .graphemes(true)
            .take_while(|cluster| {
                let count = cluster.chars().count();
                if count > capacity {
                    return false;
                }
                capacity -= count;
                true
            })
            .collect();
        self.session
            .begin_composition()
            .map_err(|e| e.to_string())?;
        self.session
            .update_preedit(&bounded)
            .map_err(|e| e.to_string())?;
        self.session.commit().map(|_| ()).map_err(|e| e.to_string())
    }
    pub(super) fn ime(&mut self, event: Ime) -> Result<(), String> {
        match event {
            Ime::Enabled => self.focus(true),
            Ime::Disabled => {
                if self.session.is_composing() {
                    self.session
                        .cancel_composition()
                        .map_err(|e| e.to_string())?;
                }
            }
            Ime::Commit(text) => return self.append(&text),
            Ime::Preedit(text, _) => {
                if text.is_empty() {
                    if self.session.is_composing() {
                        self.session
                            .cancel_composition()
                            .map_err(|e| e.to_string())?;
                    }
                } else {
                    if !self.session.is_composing() {
                        self.session
                            .begin_composition()
                            .map_err(|e| e.to_string())?;
                    }
                    self.session
                        .update_preedit(&text)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composition_is_atomic_and_backspace_deletes_whole_graphemes() {
        let mut editor = AnnotationEditor::new("泵").unwrap();
        editor
            .ime(Ime::Preedit("wen".into(), Some((0, 3))))
            .unwrap();
        assert_eq!(editor.text(), "泵");
        editor.ime(Ime::Commit("温e\u{301}👨‍👩‍👧‍👦".into())).unwrap();
        assert_eq!(editor.text(), "泵温e\u{301}👨‍👩‍👧‍👦");
        assert_eq!(editor.preedit(), "");
        editor.backspace().unwrap();
        assert_eq!(editor.text(), "泵温e\u{301}");
        editor.backspace().unwrap();
        assert_eq!(editor.text(), "泵温");
        editor.session.undo().unwrap();
        assert_eq!(editor.text(), "泵温e\u{301}");
        editor.session.redo().unwrap();
        assert_eq!(editor.text(), "泵温");
    }
    #[test]
    fn focus_loss_cancels_preedit_and_rejects_late_commit_until_refocused() {
        let mut editor = AnnotationEditor::new("中文").unwrap();
        editor.ime(Ime::Preedit("pending".into(), None)).unwrap();
        editor.focus(false);
        assert_eq!(editor.preedit(), "");
        assert!(editor.ime(Ime::Commit("迟到".into())).is_err());
        assert_eq!(editor.text(), "中文");
        editor.focus(true);
        editor.ime(Ime::Commit(" שלום".into())).unwrap();
        assert_eq!(editor.text(), "中文 שלום");
    }
    #[test]
    fn text_budget_never_slices_combining_or_emoji_clusters() {
        let mut editor = AnnotationEditor::new(&"a".repeat(255)).unwrap();
        editor.append("e\u{301}👨‍👩‍👧‍👦").unwrap();
        assert_eq!(editor.text().chars().count(), 255);
        editor.append("\n中").unwrap();
        assert_eq!(editor.text().chars().count(), 256);
        assert!(editor.text().ends_with('中'));
        assert!(editor.ime(Ime::Preedit("a".repeat(4097), None)).is_err());
        assert_eq!(editor.text().chars().count(), 256);
    }

    #[test]
    fn disabling_ime_cancels_composition_but_keeps_keyboard_input_available() {
        let mut editor = AnnotationEditor::new("中").unwrap();
        editor.ime(Ime::Preedit("pending".into(), None)).unwrap();
        editor.ime(Ime::Disabled).unwrap();
        assert_eq!(editor.preedit(), "");
        editor.append("abc").unwrap();
        assert_eq!(editor.text(), "中abc");
    }
}
