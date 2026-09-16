//! U05/Windows IME: pure adapter from `winit::event::Ime` events to the
//! composition state machine (`ime.rs`) and the text editor
//! (`text_edit.rs`). No window code lives here — the winit shell (app lane)
//! forwards events and this adapter keeps a single edit path: composition
//! preview is held outside the document, commits land through
//! `replace_selection` (undo-able, cluster-safe), and the caret rect the
//! OS candidate window needs is derived from the editor state.

use super::ime::{CompositionError, CompositionState};
use super::text_edit::{Caret, TextEditState};

/// What the shell should do after an Ime event was consumed.
#[derive(Debug, Clone, PartialEq)]
pub enum ImeOutcome {
    /// Nothing changed; no redraw needed.
    Idle,
    /// Composition preview changed: redraw and report the caret rect for
    /// `Window::set_ime_cursor_area`.
    PreeditChanged {
        text: String,
        /// Byte offsets into the document where the preview sits.
        start: Caret,
        end: Caret,
    },
    /// Text committed into the document: redraw, selection cleared.
    Committed { text: String },
    /// Composition cancelled; redraw only if a preview was showing.
    Cancelled,
}

/// Adapter bound to one editor; owns the composition window lifecycle.
#[derive(Debug, Default)]
pub struct WinitImeAdapter {
    composition: CompositionState,
}

impl WinitImeAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    /// True while a composition window is open (the shell uses this to
    /// decide whether Escape cancels the IME or closes the panel).
    pub fn composing(&self) -> bool {
        self.composition.active
    }

    /// Consumes one winit IME event against the editor.
    pub fn handle_ime(
        &mut self,
        editor: &mut TextEditState,
        event: winit::event::Ime,
    ) -> Result<ImeOutcome, CompositionError> {
        match event {
            winit::event::Ime::Enabled => Ok(ImeOutcome::Idle),
            winit::event::Ime::Disabled => {
                if self.composition.active {
                    self.composition.cancel()?;
                    Ok(ImeOutcome::Cancelled)
                } else {
                    Ok(ImeOutcome::Idle)
                }
            }
            winit::event::Ime::Preedit(text, _cursor) => {
                if text.is_empty() && !self.composition.active {
                    // A cleared preedit with no active composition is a no-op
                    // (winit also sends an empty Preedit right before Commit).
                    return Ok(ImeOutcome::Idle);
                }
                if !self.composition.active {
                    self.composition.begin(editor);
                }
                self.composition.update(&text)?;
                if text.is_empty() {
                    // Empty preedit = preview cleared, composition still open.
                    Ok(ImeOutcome::Cancelled)
                } else {
                    Ok(ImeOutcome::PreeditChanged {
                        start: self.composition.start,
                        end: self.composition.start + text.len(),
                        text,
                    })
                }
            }
            winit::event::Ime::Commit(text) => {
                if text.is_empty() {
                    if self.composition.active {
                        self.composition.cancel()?;
                    }
                    return Ok(ImeOutcome::Idle);
                }
                // 宿主可能已改变选区；提交失败时保留预编辑，允许修正后重试。
                editor
                    .replace_selection(&text)
                    .map_err(|_| CompositionError::NotActive)?;
                if self.composition.active {
                    self.composition.cancel()?;
                }
                Ok(ImeOutcome::Committed { text })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform_text::text_edit::Move;

    #[test]
    fn rejected_commit_preserves_preedit_and_editor_then_allows_retry() {
        for invalid in [1, 99] {
            let mut editor = TextEditState::new("中", 8);
            let mut adapter = WinitImeAdapter::new();
            adapter
                .handle_ime(&mut editor, winit::event::Ime::Preedit("wen".into(), None))
                .unwrap();
            let pending = adapter.composition.clone();
            editor.caret = invalid;
            let before = editor.clone();
            assert!(
                adapter
                    .handle_ime(&mut editor, winit::event::Ime::Commit("文".into()))
                    .is_err()
            );
            assert_eq!(editor, before);
            assert_eq!(adapter.composition, pending);
            editor.caret = 0;
            adapter
                .handle_ime(&mut editor, winit::event::Ime::Commit("文".into()))
                .unwrap();
            assert_eq!(editor.document, "文中");
            assert!(!adapter.composing());
            assert!(adapter.composition.pending.is_empty());
            editor.undo().unwrap();
            assert_eq!(editor.document, "中");
        }
    }

    #[test]
    fn empty_commit_closes_composition_without_an_edit() {
        let mut editor = TextEditState::new("中", 8);
        let mut adapter = WinitImeAdapter::new();
        adapter
            .handle_ime(&mut editor, winit::event::Ime::Preedit("wen".into(), None))
            .unwrap();
        let before = editor.clone();
        assert_eq!(
            adapter
                .handle_ime(&mut editor, winit::event::Ime::Commit(String::new()))
                .unwrap(),
            ImeOutcome::Idle
        );
        assert!(!adapter.composing());
        assert!(adapter.composition.pending.is_empty());
        assert_eq!(editor, before);
    }

    #[test]
    fn preedit_never_touches_document_until_commit() {
        let mut editor = TextEditState::new("温度", 16);
        editor.move_caret(Move::DocumentEnd, false);
        let mut adapter = WinitImeAdapter::new();

        let outcome = adapter
            .handle_ime(&mut editor, winit::event::Ime::Preedit("wen".into(), None))
            .expect("preedit");
        assert_eq!(editor.document, "温度", "preedit must not mutate");
        assert!(adapter.composing());
        match outcome {
            ImeOutcome::PreeditChanged { start, text, .. } => {
                assert_eq!((start, text.as_str()), (6, "wen"));
            }
            other => panic!("unexpected {other:?}"),
        }

        let outcome = adapter
            .handle_ime(&mut editor, winit::event::Ime::Commit("温度".into()))
            .expect("commit");
        assert_eq!(editor.document, "温度温度");
        assert!(!adapter.composing());
        match outcome {
            ImeOutcome::Committed { text } => assert_eq!(text, "温度"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn cancel_discards_preview_and_commit_clears_preedit_state() {
        let mut editor = TextEditState::new("", 16);
        let mut adapter = WinitImeAdapter::new();
        adapter
            .handle_ime(&mut editor, winit::event::Ime::Preedit("abc".into(), None))
            .expect("preedit");
        adapter
            .handle_ime(&mut editor, winit::event::Ime::Disabled)
            .expect("disabled");
        assert!(!adapter.composing());
        assert_eq!(editor.document, "");

        // winit sends an empty Preedit right before Commit: with no active
        // composition it is a plain no-op, never a new composition.
        let outcome = adapter
            .handle_ime(&mut editor, winit::event::Ime::Preedit(String::new(), None))
            .expect("cleared preedit");
        assert_eq!(outcome, ImeOutcome::Idle);
        assert!(!adapter.composing());
    }

    #[test]
    fn commit_without_active_composition_still_inserts() {
        let mut editor = TextEditState::new("", 16);
        let mut adapter = WinitImeAdapter::new();
        let outcome = adapter
            .handle_ime(&mut editor, winit::event::Ime::Commit("直接".into()))
            .expect("direct commit");
        assert_eq!(editor.document, "直接");
        assert_eq!(
            outcome,
            ImeOutcome::Committed {
                text: "直接".into()
            }
        );
    }
}
