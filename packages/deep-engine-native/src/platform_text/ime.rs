//! U05: IME composition state machine. The composition window (pending
//! pre-edit string + caret placement) is held OUTSIDE the committed document
//! until it resolves: confirm commits through `TextEditState::replace_selection`
//! semantics, cancel discards without touching the document. The OS renders
//! the candidate window at the caret rect the runtime reports — this module
//! owns only the state, never the UI.

#[cfg(test)]
use super::text_edit::Move;
use super::text_edit::TextEditState;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CompositionState {
    /// Current pre-edit text (may be empty between candidate refreshes).
    pub pending: String,
    /// Byte offset where the composition started (insertion point).
    pub start: usize,
    /// Whether an active composition window is open.
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositionError {
    NotActive,
}

impl CompositionState {
    pub const fn inactive() -> Self {
        Self {
            pending: String::new(),
            start: 0,
            active: false,
        }
    }

    /// Starts composition at the current caret. The pending string renders
    /// inline (preview) but the document is unchanged until confirm.
    pub fn begin(&mut self, editor: &TextEditState) {
        self.pending.clear();
        self.start = editor.caret;
        self.active = true;
    }

    /// OS-driven pre-edit update (keystrokes → pinyin etc.).
    pub fn update(&mut self, pending: &str) -> Result<(), CompositionError> {
        if !self.active {
            return Err(CompositionError::NotActive);
        }
        self.pending = pending.to_string();
        Ok(())
    }

    /// Commits the final text into the document at the composition start.
    /// Returns the commit text so the caller routes it through
    /// `replace_selection` (single edit path, undo-able).
    pub fn confirm(&mut self) -> Result<String, CompositionError> {
        if !self.active {
            return Err(CompositionError::NotActive);
        }
        let committed = std::mem::take(&mut self.pending);
        self.active = false;
        Ok(committed)
    }

    /// Cancels: pending text is discarded, document untouched.
    pub fn cancel(&mut self) -> Result<(), CompositionError> {
        if !self.active {
            return Err(CompositionError::NotActive);
        }
        self.pending.clear();
        self.active = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_routes_one_commit_through_the_document_edit_path() {
        let mut editor = TextEditState::new("hello ", 16);
        editor.move_caret(Move::DocumentEnd, false);
        let mut composition = CompositionState::inactive();
        composition.begin(&editor);
        composition.update("ni hao").expect("pre-edit");
        assert_eq!(composition.pending, "ni hao");
        assert_eq!(
            editor.document, "hello ",
            "document untouched during composition"
        );

        let committed = composition.confirm().expect("commit");
        editor.replace_selection(&committed).expect("route commit");
        assert_eq!(editor.document, "hello ni hao");
        assert!(!composition.active);
    }

    #[test]
    fn cancel_discards_and_document_stays_intact() {
        let mut editor = TextEditState::new("状态", 16);
        editor.move_caret(Move::DocumentEnd, false);
        let mut composition = CompositionState::inactive();
        composition.begin(&editor);
        composition.update("yun xing zhong").expect("pre-edit");
        composition.cancel().expect("cancel");
        assert_eq!(editor.document, "状态", "cancel never mutates the document");
        assert!(matches!(
            composition.update("x"),
            Err(CompositionError::NotActive)
        ));
    }

    #[test]
    fn composition_requires_activation_and_repositions_per_caret() {
        let mut editor = TextEditState::new("abc", 16);
        editor.move_caret(Move::DocumentEnd, false);
        let mut composition = CompositionState::inactive();
        assert!(matches!(
            composition.update("x"),
            Err(CompositionError::NotActive)
        ));
        composition.begin(&editor);
        assert_eq!(composition.start, 3, "composition anchors at the caret");
        assert!(composition.active);
    }
}
