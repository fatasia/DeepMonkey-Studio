//! P1-18 版本化文本 IR 的合同测试。
//!
//! 覆盖三层:构造校验(越界/乱序/重叠必须拒绝)、查询(样式/段落/inline 二分正确)、
//! 编辑后失效(样式随簇平移、插入继承插入点样式、对象跟随位置、revision 单调)。

use super::*;

fn span(start: usize, end: usize, style: u16) -> StyleSpan {
    StyleSpan {
        start_cluster: start,
        end_cluster: end,
        style: TextStyleId(style),
    }
}

fn document(text: &str) -> TextDocumentV1 {
    TextDocumentV1::new(text, Vec::new(), Vec::new(), Vec::new()).expect("valid document")
}

// ---- 簇边界:区间一律落在字素簇上,不用字节偏移 ----

/// 一个 emoji 是 4 字节但只占 1 簇;区间按簇表达时不会切开它。
#[test]
fn spans_are_cluster_indexed_so_multibyte_clusters_stay_intact() {
    let text = "a👍b";
    let mut doc = TextDocumentV1::new(text, vec![span(1, 2, 7)], Vec::new(), Vec::new()).unwrap();
    assert_eq!(doc.cluster_count(), 3, "a / 👍 / b");
    assert_eq!(doc.cluster_text(1), Some("👍"));
    assert_eq!(doc.style_at(1), Some(TextStyleId(7)));
    assert_eq!(doc.style_at(0), None, "未覆盖的簇不发明默认样式");
    // 字节范围确实是 1..5,但对外只暴露簇索引。
    assert_eq!(doc.cluster_bytes(1), Some((1, 5)));

    // 编辑点落在簇边界上:整体替换 emoji 不破坏任何区间。
    let change = doc.replace_clusters(1, 2, "中").unwrap();
    assert_eq!(doc.text(), "a中b");
    assert_eq!(doc.cluster_count(), 3);
    assert_eq!(doc.style_at(1), Some(TextStyleId(7)), "同簇数替换保持样式");
    assert_eq!(change.previous_revision, 1);
    assert_eq!(change.revision, 2);
}

// ---- 构造校验:坏输入必须拒绝,不能静默修正 ----

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

    let out_of_bounds =
        TextDocumentV1::new("ab", vec![span(0, 5, 1)], Vec::new(), Vec::new());
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
    assert!(matches!(
        TextDocumentV1::new("abcd", Vec::new(), vec![], vec![]),
        Ok(_)
    ));
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
    let out_of_bounds =
        TextDocumentV1::new("ab", Vec::new(), Vec::new(), vec![InlineObject {
            at_cluster: 9,
            object_id: "icon".into(),
        }]);
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

/// 空文档合法:0 簇,段落铺成空区间,查询一律 None。
#[test]
fn empty_document_is_valid_and_has_no_clusters() {
    let doc = document("");
    assert_eq!(doc.cluster_count(), 0);
    assert_eq!(doc.style_at(0), None);
    assert_eq!(doc.paragraph_at(0), None);
    assert_eq!(doc.cluster_bytes(0), None);
    assert_eq!(doc.paragraphs().len(), 1, "空文档仍有一条空段落");
}

// ---- 查询:二分正确,边界不含右端 ----

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

// ---- 编辑后失效:样式平移、插入继承、对象跟随 ----

/// 编辑点之前不变、之后整体平移,revision 单调递增。
#[test]
fn editing_shifts_spans_after_the_edit_point() {
    let mut doc = TextDocumentV1::new(
        "abcdef",
        vec![span(0, 2, 1), span(4, 6, 2)],
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    // 在簇 2 前插入两个簇("XY"),原 [4,6) 应平移到 [6,8)。
    let change = doc.replace_clusters(2, 2, "XY").unwrap();
    assert_eq!(doc.text(), "abXYcdef");
    assert_eq!(doc.cluster_count(), 8);
    assert_eq!(change.cluster_count_changed, true);
    assert_eq!(doc.style_at(0), Some(TextStyleId(1)), "编辑点前不变");
    assert_eq!(doc.style_at(2), Some(TextStyleId(1)), "插入内容继承插入点样式");
    assert_eq!(doc.style_at(3), Some(TextStyleId(1)));
    assert_eq!(doc.style_at(6), Some(TextStyleId(2)), "原 [4,6) 平移到 [6,8)");
    assert_eq!(doc.style_at(7), Some(TextStyleId(2)));
    assert_eq!(change.previous_revision, 1);
    assert_eq!(doc.revision(), 2, "revision 单调递增");
}

/// 删除跨越样式的整段:受影响的区间收缩而不残留空洞。
#[test]
fn deleting_clusters_keeps_the_remaining_spans_consistent() {
    let mut doc = TextDocumentV1::new(
        "abcdef",
        vec![span(0, 2, 1), span(2, 4, 2), span(4, 6, 3)],
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    // 删除簇 [1,5):保留 "af";样式 1 收缩到 [0,1),样式 3 从 5 平移到 1。
    doc.replace_clusters(1, 5, "").unwrap();
    assert_eq!(doc.text(), "af");
    assert_eq!(doc.cluster_count(), 2);
    assert_eq!(doc.style_at(0), Some(TextStyleId(1)), "左段收缩到编辑点");
    assert_eq!(
        doc.style_at(1),
        Some(TextStyleId(3)),
        "右段从删除段之后平移进来"
    );
    // 中间那条 [2,4) 被整段删掉,不应复活。
    assert!(
        doc.styles().iter().all(|s| s.style != TextStyleId(2)),
        "被完全删除的样式区间必须消失: {:?}",
        doc.styles()
    );
    assert!(doc.styles().iter().all(|s| s.start_cluster < s.end_cluster));
}

/// inline object 跟随位置:编辑点之前的原位、之后的平移、被删除段吞掉的消失。
#[test]
fn inline_objects_follow_edits_and_disappear_with_their_range() {
    let mut doc = TextDocumentV1::new(
        "abcdef",
        Vec::new(),
        Vec::new(),
        vec![
            InlineObject {
                at_cluster: 1,
                object_id: "before".into(),
            },
            InlineObject {
                at_cluster: 4,
                object_id: "after".into(),
            },
        ],
    )
    .unwrap();

    // 在簇 2 前插入 3 簇:位置 1 不变,位置 4 平移到 7。
    doc.replace_clusters(2, 2, "XYZ").unwrap();
    assert_eq!(doc.text(), "abXYZcdef");
    let positions = doc
        .inline_objects()
        .iter()
        .map(|o| (o.object_id.as_str(), o.at_cluster))
        .collect::<Vec<_>>();
    assert_eq!(positions, vec![("before", 1), ("after", 7)]);

    // 删除 [0,2):位置 1 落在删除段内 → 对象消失;位置 7 平移到 5。
    doc.replace_clusters(0, 2, "").unwrap();
    let positions = doc
        .inline_objects()
        .iter()
        .map(|o| (o.object_id.as_str(), o.at_cluster))
        .collect::<Vec<_>>();
    assert_eq!(positions, vec![("after", 5)], "被删除段吞掉的对象消失");
}

/// 每个簇恒属某段落:极端删除后段落不变量保持。
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

/// `set_styles` 只推 revision 并报告覆盖区间,不改文本。
#[test]
fn set_styles_reports_the_affected_extent() {
    let mut doc = TextDocumentV1::new("abcdef", vec![span(0, 2, 1)], Vec::new(), Vec::new())
        .unwrap();
    let change = doc.set_styles(vec![span(2, 6, 5)]).unwrap();
    assert_eq!(doc.text(), "abcdef", "样式修改不动文本");
    assert_eq!(change.cluster_count_changed, false);
    assert_eq!(change.start_cluster, 0);
    assert_eq!(change.end_cluster, 6, "覆盖两侧最大范围");
    assert_eq!(doc.style_at(0), None, "旧样式已撤下");
    assert_eq!(doc.style_at(4), Some(TextStyleId(5)));
    assert_eq!(doc.revision(), 2);

    // 越界样式表仍被拒绝,且不改变文档。
    assert!(doc.set_styles(vec![span(0, 9, 1)]).is_err());
    assert_eq!(doc.revision(), 2, "拒绝的修改不推进 revision");
}

/// 替换越界必须拒绝,不静默截断。
#[test]
fn out_of_range_replacement_is_rejected() {
    let mut doc = document("abc");
    assert!(doc.replace_clusters(0, 9, "x").is_err());
    assert!(doc.replace_clusters(3, 1, "x").is_err());
    assert_eq!(doc.text(), "abc");
    assert_eq!(doc.revision(), 1, "拒绝的编辑不推进 revision");
}
// ---- 对抗式自查:以下测试针对我自己实现里最可疑的路径 ----

/// 删除段横跨**多条**样式区间时,结果必须仍满足「排序且不重叠」的不变量。
///
/// 怀疑点:两条相邻区间各自的端点都可能被收到同一个编辑点,从而产出
/// 相同起止的重叠区间。若不变量破了,`style_at` 的二分就会给出错误答案。
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

/// 连续多次编辑后所有不变量仍然成立(模拟真实编辑会话)。
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
        ("X", 0, 0),      // 头部插入
        ("", 1, 3),       // 中部删除
        ("中文", 1, 1),   // 中部插入多簇
        ("", 0, 2),       // 跨样式删除
        ("👍", 2, 2),     // 插入 4 字节簇
        ("", 1, 1),       // 单簇删除
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

/// 组合序列(基字 + 组合符)必须始终作为**一个**簇处理:
/// 在它旁边插入不应把它切开,查询也不应命中半个簇。
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
        doc.styles().iter().all(|s| s.end_cluster <= doc.cluster_count()),
        "区间随删除同步收缩"
    );
}

/// 多个 inline object 被压缩到同一编辑点时,编辑后仍不得出现重复位置
/// (构造期禁止重复,编辑期必须维持同一条不变量)。
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
    assert!(positions.iter().all(|position| *position <= doc.cluster_count()));

    // 构造期同样拒绝重复位置(与编辑期不变量一致)。
    assert!(TextDocumentV1::new(
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
    .is_err());
}

/// 构造期的段落空洞必须被补全,而不是留给下游判空。
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
