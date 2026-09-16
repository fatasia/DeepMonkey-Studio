use super::*;

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
    assert!(change.cluster_count_changed);
    assert_eq!(doc.style_at(0), Some(TextStyleId(1)), "编辑点前不变");
    assert_eq!(
        doc.style_at(2),
        Some(TextStyleId(1)),
        "插入内容继承插入点样式"
    );
    assert_eq!(doc.style_at(3), Some(TextStyleId(1)));
    assert_eq!(
        doc.style_at(6),
        Some(TextStyleId(2)),
        "原 [4,6) 平移到 [6,8)"
    );
    assert_eq!(doc.style_at(7), Some(TextStyleId(2)));
    assert_eq!(change.previous_revision, 1);
    assert_eq!(doc.revision(), 2, "revision 单调递增");
}

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

#[test]
fn set_styles_reports_the_affected_extent() {
    let mut doc =
        TextDocumentV1::new("abcdef", vec![span(0, 2, 1)], Vec::new(), Vec::new()).unwrap();
    let change = doc.set_styles(vec![span(2, 6, 5)]).unwrap();
    assert_eq!(doc.text(), "abcdef", "样式修改不动文本");
    assert!(!change.cluster_count_changed);
    assert_eq!(change.start_cluster, 0);
    assert_eq!(change.end_cluster, 6, "覆盖两侧最大范围");
    assert_eq!(doc.style_at(0), None, "旧样式已撤下");
    assert_eq!(doc.style_at(4), Some(TextStyleId(5)));
    assert_eq!(doc.revision(), 2);

    // 越界样式表仍被拒绝,且不改变文档。
    assert!(doc.set_styles(vec![span(0, 9, 1)]).is_err());
    assert_eq!(doc.revision(), 2, "拒绝的修改不推进 revision");
}

#[test]
fn out_of_range_replacement_is_rejected() {
    let mut doc = document("abc");
    assert!(doc.replace_clusters(0, 9, "x").is_err());
    assert!(doc.replace_clusters(3, 1, "x").is_err());
    assert_eq!(doc.text(), "abc");
    assert_eq!(doc.revision(), 1, "拒绝的编辑不推进 revision");
}
