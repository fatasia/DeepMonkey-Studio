//! Layout stage contract tests (U02 + U06). The source modules are mounted
//! by the main thread later; until then the tests compile them directly via
//! `#[path]`, which also exercises them outside the lib target.

#[allow(dead_code)]
#[path = "../src/native_ui/retained_ui.rs"]
mod retained_ui;

#[allow(dead_code)]
#[path = "../src/native_ui/layout.rs"]
mod layout;

#[allow(dead_code)]
#[path = "../src/native_ui/virtual_list.rs"]
mod virtual_list;

use layout::layout_tree;
use retained_ui::{
    RetainedUiA11y, RetainedUiAlign, RetainedUiContent, RetainedUiLayoutMode, RetainedUiNode,
    RetainedUiRole, RetainedUiStyle, RetainedUiTree,
};

fn style(layout: RetainedUiLayoutMode) -> RetainedUiStyle {
    RetainedUiStyle {
        layout,
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 100.0,
        min_width: None,
        max_width: None,
        min_height: None,
        max_height: None,
        padding: 0.0,
        gap: 0.0,
        grow: 0.0,
        align: RetainedUiAlign::Start,
        clip: false,
        visible: true,
        opacity: 1.0,
        pointer_events: retained_ui::RetainedUiPointerEvents::Auto,
        z_index: 0,
        background: None,
        foreground: [1.0; 4],
        border_color: None,
        border_width: 0.0,
        corner_radius: 0.0,
        font_id: None,
        font_size: 14.0,
    }
}

fn node(id: &str, parent: Option<&str>, layout: RetainedUiLayoutMode) -> RetainedUiNode {
    RetainedUiNode {
        id: id.into(),
        revision: 0,
        parent_id: parent.map(str::to_string),
        children: Vec::new(),
        style: style(layout),
        content: RetainedUiContent::Container,
        a11y: RetainedUiA11y {
            role: RetainedUiRole::Region,
            label: None,
            value: None,
        },
    }
}

fn tree(root: RetainedUiNode, nodes: Vec<RetainedUiNode>) -> RetainedUiTree {
    RetainedUiTree {
        schema_version: 1,
        id: "tree".into(),
        revision: 0,
        width: root.style.width,
        height: root.style.height,
        root_id: root.id.clone(),
        nodes: std::iter::once(root).chain(nodes).collect(),
    }
}

#[test]
fn flex_column_distributes_grow_with_gap_and_padding() {
    let mut root = node("root", None, RetainedUiLayoutMode::FlexColumn);
    root.style.height = 100.0;
    root.style.padding = 10.0;
    root.style.gap = 5.0;
    let mut a = node("a", Some("root"), RetainedUiLayoutMode::Absolute);
    a.style.height = 20.0;
    a.style.grow = 1.0;
    let mut b = node("b", Some("root"), RetainedUiLayoutMode::Absolute);
    b.style.height = 20.0;
    b.style.grow = 3.0;
    root.children = vec!["a".into(), "b".into()];
    let layout = layout_tree(&tree(root, vec![a, b])).expect("solves");
    // extra = 80 - 40 - 5 = 35 -> a gets 8.75, b gets 26.25.
    assert_eq!(layout.rects["a"], [10.0, 10.0, 100.0, 28.75]);
    assert_eq!(layout.rects["b"], [10.0, 43.75, 100.0, 46.25]);
    assert_eq!(layout.depths["a"], 1);
}

#[test]
fn flex_row_aligns_cross_axis_and_stretches() {
    let build = |align| {
        let mut root = node("root", None, RetainedUiLayoutMode::FlexRow);
        root.style.width = 200.0;
        root.style.align = align;
        let mut fixed = node("fixed", Some("root"), RetainedUiLayoutMode::Absolute);
        fixed.style.width = 50.0;
        fixed.style.height = 10.0;
        let mut grown = node("grown", Some("root"), RetainedUiLayoutMode::Absolute);
        grown.style.grow = 1.0;
        grown.style.height = 10.0;
        root.children = vec!["fixed".into(), "grown".into()];
        tree(root, vec![fixed, grown])
    };
    let layout = layout_tree(&build(RetainedUiAlign::Center)).expect("solves");
    assert_eq!(layout.rects["fixed"], [0.0, 45.0, 50.0, 10.0]); // (100-10)/2
    assert_eq!(layout.rects["grown"], [50.0, 45.0, 150.0, 10.0]);

    let layout = layout_tree(&build(RetainedUiAlign::Stretch)).expect("solves");
    assert_eq!(layout.rects["fixed"][3], 100.0); // cross size stretched
    assert_eq!(layout.rects["grown"][3], 100.0);
}

#[test]
fn stack_positions_children_with_align_and_stretch() {
    let mut root = node("root", None, RetainedUiLayoutMode::Stack);
    root.style.align = RetainedUiAlign::Center;
    let mut a = node("a", Some("root"), RetainedUiLayoutMode::Absolute);
    a.style.width = 40.0;
    a.style.height = 20.0;
    root.children = vec!["a".into()];
    let layout = layout_tree(&tree(root, vec![a])).expect("solves");
    assert_eq!(layout.rects["a"], [30.0, 40.0, 40.0, 20.0]); // centered in 100x100

    let mut stretched = node("root", None, RetainedUiLayoutMode::Stack);
    stretched.style.align = RetainedUiAlign::Stretch;
    let b = node("a", Some("root"), RetainedUiLayoutMode::Absolute);
    stretched.children = vec!["a".into()];
    let layout = layout_tree(&tree(stretched, vec![b])).expect("solves");
    assert_eq!(layout.rects["a"], [0.0, 0.0, 100.0, 100.0]);
}

#[test]
fn absolute_children_offset_from_parent_padding_box_and_clamp() {
    let mut root = node("root", None, RetainedUiLayoutMode::Absolute);
    root.style.padding = 10.0;
    let mut a = node("a", Some("root"), RetainedUiLayoutMode::Absolute);
    a.style.x = 5.0;
    a.style.y = 7.0;
    a.style.width = 500.0;
    a.style.max_width = Some(50.0);
    a.style.height = 2.0;
    a.style.min_height = Some(20.0);
    root.children = vec!["a".into()];
    let layout = layout_tree(&tree(root, vec![a])).expect("solves");
    assert_eq!(layout.rects["a"], [15.0, 17.0, 50.0, 20.0]);
}

#[test]
fn invisible_subtree_produces_no_rect() {
    let mut root = node("root", None, RetainedUiLayoutMode::Absolute);
    let mut hidden = node("hidden", Some("root"), RetainedUiLayoutMode::Absolute);
    hidden.style.visible = false;
    let deep = node("deep", Some("hidden"), RetainedUiLayoutMode::Absolute);
    hidden.children = vec!["deep".into()];
    root.children = vec!["hidden".into()];
    let layout = layout_tree(&tree(root, vec![hidden, deep])).expect("solves");
    assert!(!layout.rects.contains_key("hidden"));
    assert!(!layout.rects.contains_key("deep"));
    assert_eq!(layout.frames.len(), 1);
}

#[test]
fn clip_accumulates_down_the_chain() {
    let mut root = node("root", None, RetainedUiLayoutMode::Absolute);
    root.style.clip = true;
    root.style.width = 200.0;
    root.style.height = 200.0;
    let mut mid = node("mid", Some("root"), RetainedUiLayoutMode::Absolute);
    mid.style.clip = true;
    mid.style.x = 10.0;
    mid.style.y = 10.0;
    let mut leaf = node("leaf", Some("mid"), RetainedUiLayoutMode::Absolute);
    leaf.style.x = 20.0;
    leaf.style.y = 20.0;
    leaf.style.width = 50.0;
    leaf.style.height = 50.0;
    mid.children = vec!["leaf".into()];
    root.children = vec!["mid".into()];
    let layout = layout_tree(&tree(root, vec![mid, leaf])).expect("solves");
    assert_eq!(layout.frames[0].clip, Some([0.0, 0.0, 200.0, 200.0]));
    assert_eq!(layout.frames[1].clip, Some([10.0, 10.0, 100.0, 100.0]));
    // A node's frame carries the INHERITED scissor (TS parity): it only
    // intersects its own rect when it sets clip=true itself. Hit testing
    // still requires the point to be inside both rect and clip.
    assert_eq!(layout.frames[2].clip, Some([10.0, 10.0, 100.0, 100.0]));
}

#[test]
fn depth_beyond_budget_fails_closed() {
    let depth = 300;
    let mut nodes: Vec<RetainedUiNode> = Vec::new();
    for i in 0..depth {
        let parent = if i == 0 {
            None
        } else {
            Some(format!("n{}", i - 1))
        };
        let mut n = node(
            &format!("n{i}"),
            parent.as_deref(),
            RetainedUiLayoutMode::Absolute,
        );
        if i + 1 < depth {
            n.children = vec![format!("n{}", i + 1)];
        }
        nodes.push(n);
    }
    let mut root = node("root", None, RetainedUiLayoutMode::Absolute);
    root.style.width = 10.0;
    root.children = vec!["n0".into()];
    nodes.insert(0, root);
    let t = RetainedUiTree {
        schema_version: 1,
        id: "t".into(),
        revision: 0,
        width: 10.0,
        height: 10.0,
        root_id: "root".into(),
        nodes,
    };
    assert!(layout_tree(&t).is_err());
}

#[test]
fn non_finite_and_missing_root_fail_closed() {
    let mut root = node("root", None, RetainedUiLayoutMode::Absolute);
    root.style.width = f64::NAN;
    assert!(layout_tree(&tree(root, vec![])).is_err());
    let mut root = node("root", None, RetainedUiLayoutMode::Absolute);
    root.style.grow = f64::INFINITY;
    assert!(layout_tree(&tree(root, vec![])).is_err());
    let t = tree(node("root", None, RetainedUiLayoutMode::Absolute), vec![]);
    assert!(
        layout_tree(&RetainedUiTree {
            root_id: "nope".into(),
            ..t
        })
        .is_err()
    );
}

#[test]
fn virtual_window_is_independent_of_total() {
    use virtual_list::compute_window;
    let small = compute_window(1_000, 24.0, 480.0, 12_345.0, 4);
    let huge = compute_window(100_000, 24.0, 480.0, 12_345.0, 4);
    assert_eq!(small, huge);
    // 480/24 = 20 visible rows -> mounted budget is exactly 20 + 2*4.
    assert!(huge.visible_count + 2 * huge.overscan <= 20 + 2 * 4);
    // Scroll far past the end: clamps so the last row stays the last mounted.
    let tail = compute_window(100_000, 24.0, 480.0, 10_000_000.0, 4);
    assert_eq!(tail.first_index, 99_976);
    assert_eq!(tail.mounted_range(100_000), 99_976..100_000);
}
