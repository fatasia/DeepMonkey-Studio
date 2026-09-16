//! IME 组合事务与有限撤销历史。OS 事件和候选窗定位由宿主接线。
use super::text_document::{TextChange, TextDocumentError, TextDocumentV1};
#[path = "ime_history.rs"]
mod history;
#[path = "ime_session_types.rs"]
mod types;
use history::HistoryEntry;
pub use types::*;

const MAX_PREEDIT_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct ImeSession {
    document: TextDocumentV1,
    focused: bool,
    caret: usize,
    composition: Option<Composition>,
    undo_stack: Vec<HistoryEntry>,
    redo_stack: Vec<HistoryEntry>,
    max_history: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Composition {
    anchor: usize,
    pending: String,
}

impl ImeSession {
    pub fn new(document: TextDocumentV1, max_history: usize) -> Self {
        Self {
            document,
            focused: false,
            caret: 0,
            composition: None,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_history: max_history.max(1),
        }
    }

    pub fn document(&self) -> &TextDocumentV1 {
        &self.document
    }
    pub fn revision(&self) -> u64 {
        self.document.revision()
    }
    pub fn caret_cluster(&self) -> usize {
        self.caret
    }
    pub fn is_focused(&self) -> bool {
        self.focused
    }
    pub fn is_composing(&self) -> bool {
        self.composition.is_some()
    }
    pub fn pending(&self) -> &str {
        self.composition
            .as_ref()
            .map_or("", |composition| composition.pending.as_str())
    }
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }
    pub fn focus(&mut self) {
        self.focused = true;
    }
    pub fn blur(&mut self) {
        self.focused = false;
        self.composition = None;
    }

    pub fn set_caret(&mut self, cluster: usize) -> Result<(), ImeSessionError> {
        if cluster > self.document.cluster_count() {
            return Err(ImeSessionError::InvalidCompositionAnchor { cluster });
        }
        self.composition = None;
        self.caret = cluster;
        Ok(())
    }

    pub fn begin_composition(&mut self) -> Result<(), ImeSessionError> {
        if !self.focused {
            return Err(ImeSessionError::NotFocused);
        }
        self.composition = Some(Composition {
            anchor: self.caret,
            pending: String::new(),
        });
        Ok(())
    }

    pub fn update_preedit(&mut self, pending: &str) -> Result<(), ImeSessionError> {
        let composition = self
            .composition
            .as_mut()
            .ok_or(ImeSessionError::NoComposition)?;
        if pending.len() > MAX_PREEDIT_BYTES {
            return Err(ImeSessionError::Document(
                TextDocumentError::InvalidStyleSpan {
                    index: 0,
                    detail: "preedit exceeds 4096 bytes".into(),
                },
            ));
        }
        composition.pending = pending.to_string();
        Ok(())
    }

    /// 仅在候选通过后结束组合并记录历史。失败保留 preedit 与旧文档。
    pub fn commit(&mut self) -> Result<Option<TextChange>, ImeSessionError> {
        let composition = self
            .composition
            .as_ref()
            .ok_or(ImeSessionError::NoComposition)?;
        if composition.pending.is_empty() {
            self.composition = None;
            return Ok(None);
        }
        let caret_byte =
            self.document.boundary_byte(composition.anchor) + composition.pending.len();
        let previous = HistoryEntry {
            document: self.document.clone(),
            caret: self.caret,
        };
        let change = self.document.replace_clusters(
            composition.anchor,
            composition.anchor,
            &composition.pending,
        )?;
        self.caret = self.document.caret_after_byte(caret_byte);
        self.composition = None;
        self.record(previous);
        Ok(Some(change))
    }

    pub fn cancel_composition(&mut self) -> Result<(), ImeSessionError> {
        self.composition
            .take()
            .ok_or(ImeSessionError::NoComposition)?;
        Ok(())
    }

    /// 历史条目原子交换所有内容；revision 来自当前文档，不回退。
    pub fn undo(&mut self) -> Result<TextChange, ImeSessionError> {
        let entry = self
            .undo_stack
            .last_mut()
            .ok_or(ImeSessionError::NothingToUndo)?;
        let change = entry.exchange(&mut self.document, &mut self.caret)?;
        self.redo_stack
            .push(self.undo_stack.pop().expect("history checked"));
        self.composition = None;
        Ok(change)
    }

    pub fn redo(&mut self) -> Result<TextChange, ImeSessionError> {
        let entry = self
            .redo_stack
            .last_mut()
            .ok_or(ImeSessionError::NothingToRedo)?;
        let change = entry.exchange(&mut self.document, &mut self.caret)?;
        self.undo_stack
            .push(self.redo_stack.pop().expect("history checked"));
        self.composition = None;
        Ok(change)
    }

    pub fn backspace(&mut self) -> Result<Option<TextChange>, ImeSessionError> {
        if self.caret == 0 {
            self.composition = None;
            return Ok(None);
        }
        let target = self.caret - 1;
        let caret_byte = self.document.boundary_byte(target);
        let previous = HistoryEntry {
            document: self.document.clone(),
            caret: self.caret,
        };
        let change = self.document.replace_clusters(target, self.caret, "")?;
        self.caret = self.document.caret_after_byte(caret_byte);
        self.composition = None;
        self.record(previous);
        Ok(Some(change))
    }

    fn record(&mut self, entry: HistoryEntry) {
        self.undo_stack.push(entry);
        if self.undo_stack.len() > self.max_history {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    /// 单行量测锚点；多行/bidi 与 DPI 的实际候选窗仍由宿主负责。
    pub fn caret_rect(&self, line_height: f64, advance_of: &ClusterAdvance) -> (usize, [f64; 4]) {
        let x = (0..self.caret)
            .filter_map(|index| self.document.cluster_text(index))
            .map(advance_of)
            .sum::<f64>();
        (self.caret, [x, 0.0, 0.0, line_height.max(0.0)])
    }
}

#[cfg(test)]
#[path = "ime_session_tests.rs"]
mod tests;
