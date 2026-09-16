use deep_engine_native::platform_text::{
    ImeSession, InlineObject, Paragraph, ParagraphAlign, StyleSpan, TextDocumentV1, TextStyleId,
};

fn styled(text: &str) -> TextDocumentV1 {
    let count = TextDocumentV1::new(text, vec![], vec![], vec![])
        .unwrap()
        .cluster_count();
    TextDocumentV1::new(
        text,
        (0..count)
            .map(|index| StyleSpan {
                start_cluster: index,
                end_cluster: index + 1,
                style: TextStyleId(index as u16),
            })
            .collect(),
        (0..count)
            .map(|index| Paragraph {
                start_cluster: index,
                end_cluster: index + 1,
                align: ParagraphAlign::Center,
            })
            .collect(),
        (0..=count)
            .map(|index| InlineObject {
                at_cluster: index,
                object_id: format!("icon-{index}"),
            })
            .collect(),
    )
    .unwrap()
}

fn same_content(actual: &TextDocumentV1, expected: &TextDocumentV1) {
    assert_eq!(actual.text(), expected.text());
    assert_eq!(actual.styles(), expected.styles());
    assert_eq!(actual.paragraphs(), expected.paragraphs());
    assert_eq!(actual.inline_objects(), expected.inline_objects());
}

fn valid(doc: &TextDocumentV1) {
    assert!(doc.styles().iter().all(
        |span| span.start_cluster < span.end_cluster && span.end_cluster <= doc.cluster_count()
    ));
    assert!(
        doc.styles()
            .windows(2)
            .all(|pair| pair[0].end_cluster <= pair[1].start_cluster)
    );
    assert!(
        doc.inline_objects()
            .windows(2)
            .all(|pair| pair[0].at_cluster < pair[1].at_cluster)
    );
    assert!(
        doc.inline_objects()
            .iter()
            .all(|object| object.at_cluster <= doc.cluster_count())
    );
    for index in 0..doc.cluster_count() {
        assert!(doc.paragraph_at(index).is_some());
    }
}

#[test]
fn redo_backspace_repeats_deletion_and_preserves_rich_metadata() {
    for text in ["ab", "a\u{0301}b", "中文", "👩‍🔬🇨🇳"] {
        let original = styled(text);
        let mut session = ImeSession::new(original.clone(), 8);
        session.focus();
        session
            .set_caret(session.document().cluster_count())
            .unwrap();
        session.backspace().unwrap();
        let deleted = session.document().clone();
        for _ in 0..3 {
            let revision = session.revision();
            session.undo().unwrap();
            same_content(session.document(), &original);
            assert!(session.revision() > revision);
            session.redo().unwrap();
            same_content(session.document(), &deleted);
        }
    }
}

#[test]
fn combining_insert_keeps_style_bounds_and_change_range_valid() {
    let mut doc = styled("a");
    let change = doc.replace_clusters(1, 1, "\u{0301}").unwrap();
    assert_eq!(doc.cluster_count(), 1);
    assert_eq!(
        (
            change.start_cluster,
            change.end_cluster,
            change.previous_end_cluster
        ),
        (0, 1, 1)
    );
    assert!(!change.cluster_count_changed);
    assert_eq!(doc.style_at(0), Some(TextStyleId(0)));
    valid(&doc);
}

#[test]
fn merging_composition_caret_and_history_follow_full_document_boundaries() {
    for (text, anchor, inserted, expected_caret) in [
        ("a", 1, "\u{0301}", 1),
        ("👩🔬", 1, "\u{200d}", 1),
        ("🇨", 1, "🇳", 1),
        ("🇦🇧🇨🇩", 0, "🇪", 1),
        ("\r", 1, "\n", 1),
    ] {
        let original = styled(text);
        let mut session = ImeSession::new(original.clone(), 8);
        session.focus();
        session.set_caret(anchor).unwrap();
        session.begin_composition().unwrap();
        session.update_preedit(inserted).unwrap();
        session.commit().unwrap();
        assert_eq!(
            session.caret_cluster(),
            expected_caret,
            "{text:?} + {inserted:?}"
        );
        valid(session.document());
        let changed = session.document().clone();
        session.undo().unwrap();
        same_content(session.document(), &original);
        assert_eq!(session.caret_cluster(), anchor);
        session.redo().unwrap();
        same_content(session.document(), &changed);
        assert_eq!(session.caret_cluster(), expected_caret);
    }
}

#[test]
fn editing_later_text_does_not_extend_earlier_styles() {
    let mut doc = TextDocumentV1::new(
        "abcdef",
        vec![StyleSpan {
            start_cluster: 0,
            end_cluster: 1,
            style: TextStyleId(4),
        }],
        vec![],
        vec![],
    )
    .unwrap();
    doc.replace_clusters(4, 4, "X").unwrap();
    assert_eq!(doc.styles()[0].end_cluster, 1);
    assert_eq!(doc.style_at(3), None);
}

#[test]
fn deletion_reports_old_affected_end_for_cached_glyph_removal() {
    let mut doc = styled("abcd");
    let change = doc.replace_clusters(1, 3, "").unwrap();
    assert_eq!(
        (
            change.start_cluster,
            change.previous_end_cluster,
            change.end_cluster
        ),
        (1, 3, 1)
    );
    valid(&doc);
}

#[test]
fn unicode_boundary_edit_matrix_keeps_all_metadata_valid() {
    for text in ["a\u{0301}b", "👩‍🔬x", "🇦🇧🇨🇩🇪", "\r\nx", "中文", ""] {
        let original = styled(text);
        for start in 0..=original.cluster_count() {
            for end in start..=original.cluster_count() {
                for replacement in ["", "x", "\u{0301}", "\u{200d}", "🇫", "\r\n"] {
                    let mut doc = original.clone();
                    let change = doc.replace_clusters(start, end, replacement).unwrap();
                    valid(&doc);
                    assert!(change.start_cluster <= change.end_cluster);
                    assert!(change.end_cluster <= doc.cluster_count());
                    assert!(change.previous_end_cluster <= original.cluster_count());
                    assert_eq!(
                        change.cluster_count_changed,
                        doc.cluster_count() != original.cluster_count()
                    );
                    same_content(&original, &styled(text));
                }
            }
        }
    }
}

#[test]
fn legacy_text_editor_moves_and_deletes_extended_clusters() {
    use deep_engine_native::platform_text::{Move, TextEditState};
    for cluster in ["a\u{0301}", "👩‍🔬", "🇨🇳", "\r\n"] {
        let mut editor = TextEditState::new(format!("{cluster}x"), 8);
        editor.move_caret(Move::Right, false);
        assert_eq!(editor.caret, cluster.len());
        editor.move_caret(Move::Left, false);
        assert_eq!(editor.caret, 0);
        editor.delete(false).unwrap();
        assert_eq!(editor.document, "x");
        editor.undo().unwrap();
        editor.move_caret(Move::Right, false);
        editor.delete(true).unwrap();
        assert_eq!(editor.document, "x");
    }
}

#[test]
fn legacy_text_editor_rejects_invalid_public_selection_atomically() {
    use deep_engine_native::platform_text::TextEditState;
    for offset in [1, 99] {
        let mut editor = TextEditState::new("中", 8);
        editor.caret = offset;
        editor.anchor = Some(0);
        let before = editor.clone();
        assert!(editor.delete(false).is_err());
        assert_eq!(editor, before);
    }
}

#[test]
fn legacy_text_editor_snaps_joined_insert_and_selection_collapse() {
    use deep_engine_native::platform_text::{Move, TextEditState};
    let mut editor = TextEditState::new("👩🔬", 8);
    editor.move_caret(Move::Right, false);
    editor.replace_selection("\u{200d}").unwrap();
    assert_eq!(editor.caret, editor.document.len());
    editor.delete(true).unwrap();
    assert_eq!(editor.document, "");
    let mut editor = TextEditState::new("abc", 8);
    editor.move_caret(Move::Right, true);
    editor.move_caret(Move::Right, false);
    assert_eq!(editor.caret, 1);
    assert_eq!(editor.anchor, None);
}
