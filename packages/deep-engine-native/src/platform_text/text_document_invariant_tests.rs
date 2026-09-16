use super::*;

#[test]
fn exhausted_revision_rejects_edits_and_snapshot_exchange_atomically() {
    let mut doc = document("abc");
    doc.revision = u64::MAX;
    let before = doc.clone();
    let mut snapshot = document("previous");
    let old_snapshot = snapshot.clone();
    assert_eq!(
        doc.replace_clusters(1, 2, "X"),
        Err(TextDocumentError::RevisionExhausted)
    );
    assert_eq!(
        doc.set_styles(vec![]),
        Err(TextDocumentError::RevisionExhausted)
    );
    assert_eq!(
        doc.exchange_snapshot(&mut snapshot),
        Err(TextDocumentError::RevisionExhausted)
    );
    assert_eq!(doc, before);
    assert_eq!(snapshot, old_snapshot);
}

#[test]
fn document_snapshots_share_payload_until_edit() {
    let mut doc = TextDocumentV1::new("abc", vec![span(0, 3, 7)], vec![], vec![]).unwrap();
    let snapshot = doc.clone();
    assert!(std::ptr::eq(doc.text(), snapshot.text()));
    assert_eq!(doc.styles().as_ptr(), snapshot.styles().as_ptr());
    doc.replace_clusters(1, 2, "中").unwrap();
    assert_eq!(snapshot.text(), "abc");
    assert_eq!(snapshot.styles()[0], span(0, 3, 7));
    assert_eq!(doc.text(), "a中c");
}

#[test]
fn paragraphs_always_cover_every_cluster() {
    let mut doc = TextDocumentV1::new(
        "abcdef",
        Vec::new(),
        vec![
            Paragraph {
                start_cluster: 0,
                end_cluster: 3,
                align: ParagraphAlign::Start,
            },
            Paragraph {
                start_cluster: 3,
                end_cluster: 6,
                align: ParagraphAlign::End,
            },
        ],
        Vec::new(),
    )
    .unwrap();
    doc.replace_clusters(0, 6, "").unwrap();
    assert_eq!(doc.cluster_count(), 0);
    assert_eq!(doc.paragraphs().len(), 1, "全删后补回默认段落");

    doc.replace_clusters(0, 0, "中文").unwrap();
    for cluster in 0..doc.cluster_count() {
        assert!(
            doc.paragraph_at(cluster).is_some(),
            "簇 {cluster} 必须落在某段落内"
        );
    }
}

#[test]
fn deleting_across_multiple_spans_keeps_spans_sorted_and_disjoint() {
    let mut doc = TextDocumentV1::new(
        "abcdefgh",
        vec![span(0, 2, 1), span(2, 4, 2), span(4, 6, 3), span(6, 8, 4)],
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    // 删除 [3,7):横跨样式 2/3/4 三条区间。
    doc.replace_clusters(3, 7, "").unwrap();
    assert_eq!(doc.text(), "abch");

    let spans = doc.styles();
    for pair in spans.windows(2) {
        assert!(
            pair[0].end_cluster <= pair[1].start_cluster,
            "区间必须排序且不重叠,实际 {:?}",
            spans
        );
    }
    assert!(
        spans.iter().all(|s| s.start_cluster < s.end_cluster),
        "不得出现空区间: {:?}",
        spans
    );
    // 每个簇的查询结果必须唯一确定(若重叠,相邻簇会给出矛盾样式)。
    for cluster in 0..doc.cluster_count() {
        let _ = doc.style_at(cluster);
    }
}

#[test]
fn repeated_edits_preserve_every_invariant() {
    let mut doc = TextDocumentV1::new(
        "中文abc👍",
        vec![span(0, 2, 1), span(2, 3, 2), span(3, 5, 3)],
        vec![Paragraph {
            start_cluster: 0,
            end_cluster: 5,
            align: ParagraphAlign::Start,
        }],
        vec![InlineObject {
            at_cluster: 2,
            object_id: "icon".into(),
        }],
    )
    .unwrap();

    let script: [(&str, usize, usize); 6] = [
        ("X", 0, 0),    // 头部插入
        ("", 1, 3),     // 中部删除
        ("中文", 1, 1), // 中部插入多簇
        ("", 0, 2),     // 跨样式删除
        ("👍", 2, 2),   // 插入 4 字节簇
        ("", 1, 1),     // 单簇删除
    ];
    for (replacement, start, end) in script {
        if end > doc.cluster_count() {
            continue;
        }
        doc.replace_clusters(start, end, replacement).unwrap();

        let spans = doc.styles();
        for pair in spans.windows(2) {
            assert!(
                pair[0].end_cluster <= pair[1].start_cluster,
                "样式区间必须排序且不重叠: {:?}",
                spans
            );
        }
        for span in spans {
            assert!(span.end_cluster <= doc.cluster_count(), "区间不得越界");
        }
        for cluster in 0..doc.cluster_count() {
            assert!(
                doc.paragraph_at(cluster).is_some(),
                "簇 {cluster} 必须落在某段落内"
            );
        }
        let mut positions = doc
            .inline_objects()
            .iter()
            .map(|object| object.at_cluster)
            .collect::<Vec<_>>();
        let before = positions.len();
        positions.dedup();
        assert_eq!(positions.len(), before, "inline object 位置必须唯一");
        assert!(
            doc.inline_objects()
                .iter()
                .all(|object| object.at_cluster <= doc.cluster_count()),
            "对象位置不得越界"
        );
        assert!(doc.revision() >= 2, "revision 必须递增");
    }
}

#[test]
fn combining_sequences_are_never_split_by_edits() {
    let text = "a\u{0301}b"; // á (a + combining acute) + b → 2 簇
    let mut doc = TextDocumentV1::new(text, vec![span(0, 1, 1)], Vec::new(), Vec::new()).unwrap();
    assert_eq!(doc.cluster_count(), 2);
    assert_eq!(doc.cluster_text(0), Some("a\u{0301}"));

    // 在组合序列之后插入:首簇保持不变。
    doc.replace_clusters(1, 1, "中").unwrap();
    assert_eq!(doc.cluster_text(0), Some("a\u{0301}"));
    assert_eq!(doc.text(), "a\u{0301}中b");

    // 删除组合序列本身(整簇),不得留下孤立组合符。
    doc.replace_clusters(0, 1, "").unwrap();
    assert_eq!(doc.text(), "中b");
    assert!(
        doc.styles()
            .iter()
            .all(|s| s.end_cluster <= doc.cluster_count()),
        "区间随删除同步收缩"
    );
}

#[test]
fn inline_objects_deduplicate_when_edits_collapse_them() {
    let mut doc = TextDocumentV1::new(
        "abcdef",
        Vec::new(),
        Vec::new(),
        vec![
            InlineObject {
                at_cluster: 2,
                object_id: "m".into(),
            },
            InlineObject {
                at_cluster: 4,
                object_id: "z".into(),
            },
        ],
    )
    .unwrap();
    // 删除 [2,5):位置 2 跟随编辑点、位置 4 被删除段吞掉 —— 结果只剩一个对象,
    // 且不得出现同位置重复。
    doc.replace_clusters(2, 5, "").unwrap();
    assert_eq!(doc.text(), "abf");
    let positions = doc
        .inline_objects()
        .iter()
        .map(|object| object.at_cluster)
        .collect::<Vec<_>>();
    let mut unique = positions.clone();
    unique.dedup();
    assert_eq!(positions.len(), unique.len(), "位置必须唯一: {positions:?}");
    assert!(
        positions
            .iter()
            .all(|position| *position <= doc.cluster_count())
    );

    // 构造期同样拒绝重复位置(与编辑期不变量一致)。
    assert!(
        TextDocumentV1::new(
            "abc",
            Vec::new(),
            Vec::new(),
            vec![
                InlineObject {
                    at_cluster: 1,
                    object_id: "a".into(),
                },
                InlineObject {
                    at_cluster: 1,
                    object_id: "b".into(),
                },
            ],
        )
        .is_err()
    );
}
