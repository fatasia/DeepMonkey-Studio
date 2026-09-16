//! U05: text-editing state machine over the cluster contract. Cursor and
//! selection move by grapheme cluster (never UTF-16 units), edits are
//! cluster-scoped, and undo/redo is a bounded snapshot stack. IME
//! composition windows plug in by holding the pending string separately —
//! the committed document is only ever mutated through this state machine.

use super::layout::grapheme_clusters;

/// Byte offset into the document; always a cluster boundary after any op.
pub type Caret = usize;

#[derive(Debug, Clone, PartialEq)]
pub struct TextEditState {
    pub document: String,
    pub caret: Caret,
    /// Selection anchor (byte offset); `Some` while a selection exists.
    pub anchor: Option<Caret>,
    undo: Vec<(String, Caret)>,
    redo: Vec<(String, Caret)>,
    max_history: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Move {
    Left,
    Right,
    WordStart,
    WordEnd,
    LineStart,
    LineEnd,
    DocumentStart,
    DocumentEnd,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EditError {
    NotAClusterBoundary(usize),
    NothingToUndo,
    NothingToRedo,
}

impl TextEditState {
    pub fn new(document: impl Into<String>, max_history: usize) -> Self {
        Self {
            document: document.into(),
            caret: 0,
            anchor: None,
            undo: Vec::new(),
            redo: Vec::new(),
            max_history: max_history.max(1),
        }
    }

    fn boundaries(&self) -> Vec<usize> {
        let mut bounds = vec![0usize];
        for cluster in grapheme_clusters(&self.document, |_| 0.0) {
            bounds.push(cluster.end);
        }
        bounds
    }

    fn snap(&self, offset: usize) -> Result<Caret, EditError> {
        if self.boundaries().contains(&offset) || offset == 0 {
            Ok(offset)
        } else {
            Err(EditError::NotAClusterBoundary(offset))
        }
    }

    fn push_undo(&mut self) {
        self.undo.push((self.document.clone(), self.caret));
        if self.undo.len() > self.max_history {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// Moves the caret; any movement collapses the selection unless
    /// `extend` is set (shift-held semantics).
    pub fn move_caret(&mut self, movement: Move, extend: bool) {
        let bounds = self.boundaries();
        self.anchor = self.anchor.map(|anchor| {
            bounds[bounds.partition_point(|&byte| byte < anchor.min(self.document.len()))]
        });
        self.caret = bounds[bounds
            .partition_point(|&byte| byte <= self.caret)
            .saturating_sub(1)];
        if !extend {
            if let Some(anchor) = self.anchor {
                self.caret = if matches!(movement, Move::Left) {
                    self.caret.min(anchor)
                } else {
                    self.caret.max(anchor)
                };
                self.anchor = None;
                if matches!(movement, Move::Left | Move::Right) {
                    return;
                }
            }
        } else if self.anchor.is_none() {
            self.anchor = Some(self.caret);
        }
        let bytes = self.document.as_bytes();
        match movement {
            Move::Left => {
                let index = bounds.partition_point(|&byte| byte < self.caret);
                self.caret = bounds[index.saturating_sub(1)];
            }
            Move::Right => {
                let index = bounds.partition_point(|&byte| byte <= self.caret);
                self.caret = bounds[index.min(bounds.len() - 1)];
            }
            Move::WordStart => {
                let prefix = &self.document[..self.caret];
                let trimmed = prefix.trim_end_matches(|ch: char| !ch.is_whitespace());
                self.caret = trimmed.len();
            }
            Move::WordEnd => {
                let rest = &self.document[self.caret..];
                let skip = rest
                    .find(|ch: char| ch.is_whitespace())
                    .unwrap_or(rest.len());
                self.caret += skip;
            }
            Move::LineStart => {
                let prefix = &self.document[..self.caret];
                self.caret = prefix.rfind(['\r', '\n']).map_or(0, |index| index + 1);
            }
            Move::LineEnd => {
                let rest = &self.document[self.caret..];
                self.caret += rest.find(['\r', '\n']).unwrap_or(rest.len());
            }
            Move::DocumentStart => self.caret = 0,
            Move::DocumentEnd => self.caret = bytes.len(),
        }
        self.caret = bounds[bounds.partition_point(|&byte| byte < self.caret)];
    }

    /// The selected byte range in document order, if any.
    pub fn selection(&self) -> Option<(usize, usize)> {
        let anchor = self.anchor?;
        Some(if anchor <= self.caret {
            (anchor, self.caret)
        } else {
            (self.caret, anchor)
        })
    }

    /// Replaces the selection (or inserts at the caret) with `text`.
    /// IME commit flows through here once composition resolves.
    pub fn replace_selection(&mut self, text: &str) -> Result<(), EditError> {
        // Snap-check the incoming range stays on cluster boundaries.
        let (start, end) = self.selection().unwrap_or((self.caret, self.caret));
        self.snap(start)?;
        self.snap(end)?;
        self.push_undo();
        let mut next = String::with_capacity(self.document.len() + text.len());
        next.push_str(&self.document[..start]);
        next.push_str(text);
        next.push_str(&self.document[end..]);
        self.document = next;
        self.caret = self
            .boundaries()
            .into_iter()
            .find(|&byte| byte >= start + text.len())
            .expect("document end is a boundary");
        self.anchor = None;
        Ok(())
    }

    /// Deletes one cluster in the given direction (backspace/forward-delete);
    /// deletes the selection when present.
    pub fn delete(&mut self, backward: bool) -> Result<bool, EditError> {
        self.snap(self.caret)?;
        if let Some(anchor) = self.anchor {
            self.snap(anchor)?;
        }
        if let Some((start, end)) = self.selection() {
            if start == end {
                self.anchor = None;
                return self.delete(backward);
            }
            self.replace_selection("")?;
            return Ok(true);
        }
        let bounds = self.boundaries();
        let index = bounds.partition_point(|&byte| byte < self.caret);
        let (from, to) = if backward {
            if index == 0 {
                return Ok(false);
            }
            (bounds[index - 1], self.caret)
        } else {
            if index + 1 == bounds.len() {
                return Ok(false);
            }
            (self.caret, bounds[index + 1])
        };
        self.push_undo();
        let mut next = String::with_capacity(self.document.len());
        next.push_str(&self.document[..from]);
        next.push_str(&self.document[to..]);
        self.document = next;
        self.caret = self
            .boundaries()
            .into_iter()
            .find(|&byte| byte >= from)
            .expect("document end is a boundary");
        Ok(true)
    }

    pub fn undo(&mut self) -> Result<(), EditError> {
        let Some((document, caret)) = self.undo.pop() else {
            return Err(EditError::NothingToUndo);
        };
        self.redo.push((self.document.clone(), self.caret));
        self.document = document;
        self.caret = caret;
        self.anchor = None;
        Ok(())
    }

    pub fn redo(&mut self) -> Result<(), EditError> {
        let Some((document, caret)) = self.redo.pop() else {
            return Err(EditError::NothingToRedo);
        };
        self.undo.push((self.document.clone(), self.caret));
        self.document = document;
        self.caret = caret;
        self.anchor = None;
        Ok(())
    }

    pub fn history_depth(&self) -> usize {
        self.undo.len()
    }
}

#[cfg(test)]
#[path = "text_edit_tests.rs"]
mod tests;
