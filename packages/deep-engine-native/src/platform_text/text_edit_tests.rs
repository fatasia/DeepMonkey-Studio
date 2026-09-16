use super::*;

#[test]
fn crlf_line_end_stops_before_the_newline_cluster() {
    let mut editor = TextEditState::new("a\r\nb", 8);
    editor.move_caret(Move::LineEnd, false);
    assert_eq!(editor.caret, 1);
    editor.move_caret(Move::Right, false);
    assert_eq!(editor.caret, 3);
    editor.move_caret(Move::LineStart, false);
    assert_eq!(editor.caret, 3);
}

#[test]
fn invalid_empty_selection_is_rejected_without_changing_state() {
    let mut editor = TextEditState::new("abc", 8);
    editor.caret = 99;
    editor.anchor = Some(99);
    let before = editor.clone();
    assert!(editor.delete(false).is_err());
    assert_eq!(editor, before);
}

#[test]
fn movement_normalizes_external_anchor_to_a_valid_boundary() {
    for anchor in [1, 99] {
        for movement in [Move::Left, Move::Right, Move::WordStart, Move::WordEnd] {
            let mut editor = TextEditState::new("中x", 8);
            editor.anchor = Some(anchor);
            editor.move_caret(movement, false);
            assert!(editor.snap(editor.caret).is_ok());
            assert_eq!(editor.anchor, None);
        }
    }
}

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
