use super::*;

#[test]
fn construction_rejects_out_of_bounds_unsorted_and_overlapping_spans() {
    let overlapping = TextDocumentV1::new(
        "abcd",
        vec![span(0, 3, 1), span(2, 4, 2)],
        Vec::new(),
        Vec::new(),
    );
    assert!(matches!(
        overlapping,
        Err(TextDocumentError::InvalidStyleSpan { index: 1, .. })
    ));

    let out_of_bounds = TextDocumentV1::new("ab", vec![span(0, 5, 1)], Vec::new(), Vec::new());
    assert!(matches!(
        out_of_bounds,
        Err(TextDocumentError::InvalidStyleSpan { index: 0, .. })
    ));

    let empty_span = TextDocumentV1::new("ab", vec![span(1, 1, 1)], Vec::new(), Vec::new());
    assert!(matches!(
        empty_span,
        Err(TextDocumentError::InvalidStyleSpan { index: 0, .. })
    ));
}

#[test]
fn construction_rejects_bad_paragraphs_and_inline_objects() {
    assert!(TextDocumentV1::new("abcd", Vec::new(), vec![], vec![]).is_ok());
    // 段落重叠。
    let bad_paragraphs = TextDocumentV1::new(
        "abcd",
        Vec::new(),
        vec![
            Paragraph {
                start_cluster: 0,
                end_cluster: 3,
                align: ParagraphAlign::Start,
            },
            Paragraph {
                start_cluster: 2,
                end_cluster: 4,
                align: ParagraphAlign::Center,
            },
        ],
        Vec::new(),
    );
    assert!(matches!(
        bad_paragraphs,
        Err(TextDocumentError::InvalidParagraph { index: 1, .. })
    ));

    // inline object 位置越界与重复。
    let out_of_bounds = TextDocumentV1::new(
        "ab",
        Vec::new(),
        Vec::new(),
        vec![InlineObject {
            at_cluster: 9,
            object_id: "icon".into(),
        }],
    );
    assert!(matches!(
        out_of_bounds,
        Err(TextDocumentError::InvalidInlineObject { index: 0, .. })
    ));
    let duplicate = TextDocumentV1::new(
        "ab",
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
    );
    assert!(matches!(
        duplicate,
        Err(TextDocumentError::InvalidInlineObject { index: 1, .. })
    ));
}

#[test]
fn empty_document_is_valid_and_has_no_clusters() {
    let doc = document("");
    assert_eq!(doc.cluster_count(), 0);
    assert_eq!(doc.style_at(0), None);
    assert_eq!(doc.paragraph_at(0), None);
    assert_eq!(doc.cluster_bytes(0), None);
    assert_eq!(doc.paragraphs().len(), 1, "空文档仍有一条空段落");
}

#[test]
fn style_and_paragraph_queries_are_half_open_and_binary_searched() {
    let doc = TextDocumentV1::new(
        "abcdef",
        vec![span(0, 2, 1), span(2, 4, 2), span(4, 6, 3)],
        vec![
            Paragraph {
                start_cluster: 0,
                end_cluster: 3,
                align: ParagraphAlign::Start,
            },
            Paragraph {
                start_cluster: 3,
                end_cluster: 6,
                align: ParagraphAlign::Justify,
            },
        ],
        Vec::new(),
    )
    .unwrap();

    assert_eq!(doc.style_at(0), Some(TextStyleId(1)));
    assert_eq!(doc.style_at(1), Some(TextStyleId(1)));
    assert_eq!(doc.style_at(2), Some(TextStyleId(2)), "左闭右开:2 属第二段");
    assert_eq!(doc.style_at(5), Some(TextStyleId(3)));
    assert_eq!(doc.style_at(6), None, "右端不属于任何区间");
    assert_eq!(
        doc.paragraph_at(3).map(|p| p.align),
        Some(ParagraphAlign::Justify)
    );

    // 局部查询用于局部重绘:只返回相交区间。
    assert_eq!(doc.styles_in(1, 3).len(), 2);
    assert_eq!(doc.styles_in(3, 4).len(), 1);
    assert_eq!(doc.styles_in(4, 4).len(), 0, "空区间无样式");
}

#[test]
fn construction_fills_paragraph_gaps_instead_of_leaving_holes() {
    // 6 簇,只标了 [0,5):末簇必须被补全覆盖。
    let doc = TextDocumentV1::new(
        "中文abc👍",
        Vec::new(),
        vec![Paragraph {
            start_cluster: 0,
            end_cluster: 5,
            align: ParagraphAlign::Start,
        }],
        Vec::new(),
    )
    .unwrap();
    assert_eq!(doc.cluster_count(), 6);
    for cluster in 0..doc.cluster_count() {
        assert!(
            doc.paragraph_at(cluster).is_some(),
            "构造后簇 {cluster} 必须已有归属"
        );
    }
    // 补全沿用相邻段落对齐,不引入新语义。
    assert_eq!(
        doc.paragraph_at(5).map(|p| p.align),
        Some(ParagraphAlign::Start)
    );
}
