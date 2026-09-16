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
        let offset = offset.min(self.document.len());
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
        if !extend {
            if let Some(anchor) = self.anchor {
                self.caret = if self.caret > anchor {
                    anchor
                } else {
                    self.caret.max(anchor)
                };
                self.caret = anchor;
                self.anchor = None;
            }
        } else if self.anchor.is_none() {
            self.anchor = Some(self.caret);
        }
        let bytes = self.document.as_bytes();
        match movement {
            Move::Left => {
                if let Some(ch) = self.document[..self.caret].chars().next_back() {
                    self.caret -= ch.len_utf8();
                }
            }
            Move::Right => {
                if let Some(ch) = self.document[self.caret..].chars().next() {
                    self.caret += ch.len_utf8();
                }
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
                self.caret = prefix.rfind('\n').map_or(0, |index| index + 1);
            }
            Move::LineEnd => {
                let rest = &self.document[self.caret..];
                self.caret += rest.find('\n').unwrap_or(rest.len());
            }
            Move::DocumentStart => self.caret = 0,
            Move::DocumentEnd => self.caret = bytes.len(),
        }
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
        self.caret = start + text.len();
        self.anchor = None;
        Ok(())
    }

    /// Deletes one cluster in the given direction (backspace/forward-delete);
    /// deletes the selection when present.
    pub fn delete(&mut self, backward: bool) -> Result<bool, EditError> {
        if let Some((start, end)) = self.selection() {
            self.push_undo();
            let mut next = String::with_capacity(self.document.len());
            next.push_str(&self.document[..start]);
            next.push_str(&self.document[end..]);
            self.document = next;
            self.caret = start;
            self.anchor = None;
            return Ok(true);
        }
        let (from, to) = if backward {
            let previous = self.document[..self.caret].chars().next_back();
            match previous {
                Some(ch) => (self.caret - ch.len_utf8(), self.caret),
                None => return Ok(false),
            }
        } else {
            match self.document[self.caret..].chars().next() {
                Some(ch) => (self.caret, self.caret + ch.len_utf8()),
                None => return Ok(false),
            }
        };
        self.push_undo();
        let mut next = String::with_capacity(self.document.len());
        next.push_str(&self.document[..from]);
        next.push_str(&self.document[to..]);
        self.document = next;
        self.caret = from;
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
mod tests {
    use super::*;

    #[test]
    fn insert_and_cluster_cursor_never_splits_emoji() {
        let mut editor = TextEditState::new("a👍b", 16);
        editor.move_caret(Move::DocumentStart, false);
        editor.move_caret(Move::Right, false);
        editor.move_caret(Move::Right, false);
        assert_eq!(editor.caret, 5, "emoji is ONE cluster = one Right press");
        editor.replace_selection("X").expect("insert at cluster");
        assert_eq!(editor.document, "a👍Xb");
        assert_eq!(editor.caret, 6);
    }

    #[test]
    fn selection_replace_and_backspace_delete_the_whole_cluster() {
        let mut editor = TextEditState::new("中文", 16);
        editor.move_caret(Move::DocumentStart, false);
        editor.move_caret(Move::Right, true);
        editor.move_caret(Move::Right, true);
        assert_eq!(
            editor.selection(),
            Some((0, 6)),
            "two CJK clusters selected"
        );
        editor.replace_selection("好").expect("replace selection");
        assert_eq!(
            editor.document, "好",
            "full selection replaced by inserted text"
        );

        let mut single = TextEditState::new("👍x", 16);
        single.move_caret(Move::DocumentEnd, false);
        assert!(single.delete(true).expect("backspace deletes 'x'"));
        assert_eq!(single.document, "👍");
        assert!(single.delete(true).expect("backspace deletes emoji whole"));
        assert_eq!(single.document, "", "4-byte emoji deleted as one unit");
        assert!(!single.delete(true).expect("no-op at start"));
    }

    #[test]
    fn undo_redo_round_trip_and_history_bound() {
        let mut editor = TextEditState::new("", 3);
        for ch in ['a', 'b', 'c', 'd', 'e'] {
            editor.replace_selection(&ch.to_string()).expect("insert");
        }
        assert_eq!(editor.document, "abcde");
        assert_eq!(editor.history_depth(), 3, "history capped at 3");
        for expected in ["abcd", "abc", "ab"] {
            editor.undo().expect("undo");
            assert_eq!(editor.document, expected);
        }
        assert!(matches!(editor.undo(), Err(EditError::NothingToUndo)));
        editor.redo().expect("redo");
        assert_eq!(editor.document, "abc");
    }

    #[test]
    fn word_and_line_movement_hit_document_edges() {
        let mut editor = TextEditState::new("hello world\n第二行", 16);
        editor.move_caret(Move::DocumentEnd, false);
        editor.move_caret(Move::LineStart, false);
        assert_eq!(editor.caret, 12, "after the newline");
        editor.move_caret(Move::WordStart, false);
        assert_eq!(editor.caret, 12, "word start at line start stays");
        editor.move_caret(Move::DocumentStart, false);
        editor.move_caret(Move::WordEnd, false);
        assert_eq!(editor.caret, 5, "end of 'hello'");
    }
}
