use super::*;
use crate::platform_text::{ImeOutcome, Move, TextEditState, WinitImeAdapter};

#[derive(Clone)]
pub(super) struct InputState {
    pub editor: TextEditState,
    pub ime: WinitImeAdapter,
    pub preedit: String,
    pub focused: bool,
}
impl Default for InputState {
    fn default() -> Self {
        Self {
            editor: TextEditState::new("", 64),
            ime: WinitImeAdapter::new(),
            preedit: String::new(),
            focused: false,
        }
    }
}
impl DashboardRuntime {
    pub fn input_focused(&self) -> bool {
        self.input_ui.focused && self.input_node().is_some()
    }
    pub fn input_value(&self) -> &str {
        &self.input_ui.editor.document
    }
    pub fn input_preedit(&self) -> &str {
        &self.input_ui.preedit
    }
    pub(super) fn input_node(&self) -> Option<&crate::runtime_package::DashboardNode> {
        let input = self.input_profile()?;
        self.document()
            .pages
            .iter()
            .find(|p| p.id == self.page_id)?
            .nodes
            .iter()
            .find(|n| n.id == input.node_id && n.visible)
    }
    pub fn input_focus(&mut self, focused: bool) -> Result<bool, String> {
        if self.input_node().is_none() || self.input_ui.focused == focused {
            return Ok(false);
        }
        self.transaction(|next| {
            if focused {
                next.select_ui.focused = false;
                next.select_ui.open = false;
                next.focus_id = next.active_input.clone();
            }
            next.input_ui.focused = focused;
            next.input_ui.ime = WinitImeAdapter::new();
            next.input_ui.preedit.clear();
            Ok(true)
        })
    }
    pub fn input_pointer(&mut self, point: Option<[f64; 2]>) -> Result<bool, String> {
        self.input_pointer_select(point, false, false)
    }
    pub fn input_ime(&mut self, event: winit::event::Ime) -> Result<bool, String> {
        if !self.input_focused() {
            return Ok(false);
        }
        self.transaction(|next| {
            match next
                .input_ui
                .ime
                .handle_ime(&mut next.input_ui.editor, event)
                .map_err(|e| format!("input IME: {e:?}"))?
            {
                ImeOutcome::Idle => return Ok(false),
                ImeOutcome::PreeditChanged { text, .. } => next.input_ui.preedit = text,
                ImeOutcome::Cancelled => next.input_ui.preedit.clear(),
                ImeOutcome::Committed { .. } => {
                    next.input_ui.preedit.clear();
                    next.apply_input_value()?;
                }
            }
            Ok(true)
        })
    }
    pub fn input_key(
        &mut self,
        key: &str,
        text: Option<&str>,
        control: bool,
        shift: bool,
    ) -> Result<bool, String> {
        if self.input_node().is_none() {
            return Ok(false);
        }
        if key == "Tab" {
            return self.input_focus(!self.input_focused());
        }
        if !self.input_focused() {
            return Ok(false);
        }
        if self.input_ui.ime.composing() {
            return Ok(false);
        }
        self.transaction(|next| {
            let editor = &mut next.input_ui.editor;
            let previous = editor.document.clone();
            match key {
                "Escape" | "Enter" => {
                    next.input_ui.focused = false;
                    return Ok(true);
                }
                "ArrowLeft" => {
                    editor.move_caret(if control { Move::WordStart } else { Move::Left }, shift)
                }
                "ArrowRight" => {
                    editor.move_caret(if control { Move::WordEnd } else { Move::Right }, shift)
                }
                "Home" => editor.move_caret(Move::DocumentStart, shift),
                "End" => editor.move_caret(Move::DocumentEnd, shift),
                "KeyA" if control => {
                    editor.move_caret(Move::DocumentStart, false);
                    editor.move_caret(Move::DocumentEnd, true);
                }
                "KeyZ" if control => {
                    if shift {
                        let _ = editor.redo();
                    } else {
                        let _ = editor.undo();
                    }
                }
                "KeyY" if control => {
                    let _ = editor.redo();
                }
                "Backspace" | "Delete" => {
                    editor
                        .delete(key == "Backspace")
                        .map_err(|e| format!("input delete: {e:?}"))?;
                }
                _ if !control => {
                    if let Some(text) = text {
                        editor
                            .replace_selection(text)
                            .map_err(|e| format!("input edit: {e:?}"))?;
                    } else {
                        return Ok(false);
                    }
                }
                _ => return Ok(false),
            }
            if next.input_ui.editor.document != previous {
                next.apply_input_value()?;
            }
            Ok(true)
        })
    }
}
