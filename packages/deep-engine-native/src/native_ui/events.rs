//! Hit testing and DOM-style event propagation over the solved layout (U03).
//! Pure CPU state machine: no windowing, no callbacks — callers map the
//! returned `(phase, node_id)` sequence onto their handler tables. Ordering
//! rules mirror `packages/deep-engine/src/retainedUi/layout.ts::hitTestRetainedUi`.

use std::collections::HashMap;

use super::layout::RetainedUiLayout;
use super::retained_ui::{RetainedUiPointerEvents, RetainedUiTree};

/// The node a pointer interaction resolves to (kept as a named type so the
/// FFI boundary can grow extra fields without breaking callers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventTarget {
    pub node_id: String,
}

pub const PHASE_CAPTURE: &str = "capture";
pub const PHASE_TARGET: &str = "target";
pub const PHASE_BUBBLE: &str = "bubble";

/// Resolves a world-space point to the topmost hittable node: highest
/// `z_index` wins, ties go to the later node in tree order (preorder). A node
/// is hittable when it is visible, not fully transparent, `pointer_events`
/// is auto, and the point is inside both its rect and its accumulated clip.
/// Nodes with `pointer_events: none` are never returned, but do not block
/// anything behind them — the search simply skips over them.
pub fn hit_test(
    layout: &RetainedUiLayout,
    tree: &RetainedUiTree,
    point: [f64; 2],
) -> Option<String> {
    if !point[0].is_finite() || !point[1].is_finite() {
        return None;
    }
    let nodes: HashMap<&str, &super::retained_ui::RetainedUiNode> = tree
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    layout
        .frames
        .iter()
        .filter(|frame| {
            let Some(node) = nodes.get(frame.id.as_str()) else {
                return false;
            };
            let style = &node.style;
            style.visible
                && style.opacity > 0.0
                && style.pointer_events == RetainedUiPointerEvents::Auto
                && contains(frame.rect, point)
                && frame.clip.is_none_or(|clip| contains(clip, point))
        })
        // Sort key: z descending, then preorder order descending so the
        // later sibling in tree order sits on top at equal z.
        .max_by_key(|frame| (frame.z_index, frame.order))
        .map(|frame| frame.id.clone())
}

/// Builds the capture → target → bubble propagation path for `hit_node_id`,
/// mirroring DOM semantics: capture visits ancestors from the root down to
/// (excluding) the target, the target phase fires once, bubble climbs from
/// the parent back to the root. `event` names the event being dispatched and
/// is carried for handler-table routing; the path itself is event-independent.
/// Unknown hit ids yield an empty path (fail closed).
pub fn dispatch(tree: &RetainedUiTree, hit_node_id: &str, event: &str) -> Vec<(String, String)> {
    let _ = event; // routing hook: the path itself is event-independent
    let parents: HashMap<&str, Option<&str>> = tree
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.parent_id.as_deref()))
        .collect();
    if !parents.contains_key(hit_node_id) {
        return Vec::new();
    }
    // Ancestor chain target -> root; depth guard defends even though the
    // validator already rejects cycles.
    let mut chain: Vec<&str> = Vec::new();
    let mut current = Some(hit_node_id);
    while let Some(id) = current {
        if chain.len() > super::retained_ui::RETAINED_UI_BUDGETS.tree_depth {
            return Vec::new();
        }
        chain.push(id);
        current = parents.get(id).copied().flatten();
    }
    let mut path: Vec<(String, String)> = Vec::with_capacity(chain.len() + 1);
    for ancestor in chain[1..].iter().rev() {
        path.push((PHASE_CAPTURE.into(), (*ancestor).into()));
    }
    path.push((PHASE_TARGET.into(), hit_node_id.into()));
    for ancestor in chain[1..].iter() {
        path.push((PHASE_BUBBLE.into(), (*ancestor).into()));
    }
    path
}

/// Half-open bounds, matching the TS hit test: a point exactly on the right
/// or bottom edge belongs to whatever sits beyond, and empty rects contain
/// nothing.
fn contains(rect: [f64; 4], point: [f64; 2]) -> bool {
    let [x, y, w, h] = rect;
    x <= point[0] && point[0] < x + w && y <= point[1] && point[1] < y + h
}

#[cfg(test)]
mod tests {
    use super::super::layout::layout_tree;
    use super::super::retained_ui::{
        RetainedUiA11y, RetainedUiContent, RetainedUiRole, RetainedUiStyle,
    };
    use super::*;

    fn style() -> RetainedUiStyle {
        RetainedUiStyle {
            layout: super::super::retained_ui::RetainedUiLayoutMode::Absolute,
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
            align: super::super::retained_ui::RetainedUiAlign::Start,
            clip: false,
            visible: true,
            opacity: 1.0,
            pointer_events: RetainedUiPointerEvents::Auto,
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

    fn node(id: &str, parent: Option<&str>) -> super::super::retained_ui::RetainedUiNode {
        super::super::retained_ui::RetainedUiNode {
            id: id.into(),
            revision: 0,
            parent_id: parent.map(str::to_string),
            children: Vec::new(),
            style: style(),
            content: RetainedUiContent::Container,
            a11y: RetainedUiA11y {
                role: RetainedUiRole::Region,
                label: None,
                value: None,
            },
        }
    }

    fn tree(nodes: Vec<super::super::retained_ui::RetainedUiNode>) -> RetainedUiTree {
        RetainedUiTree {
            schema_version: 1,
            id: "tree".into(),
            revision: 0,
            width: 100.0,
            height: 100.0,
            root_id: "root".into(),
            nodes,
        }
    }

    #[test]
    fn dispatch_walks_capture_target_bubble() {
        let mut root = node("root", None);
        let mut mid = node("mid", Some("root"));
        let leaf = node("leaf", Some("mid"));
        mid.children = vec!["leaf".into()];
        root.children = vec!["mid".into()];
        let path = dispatch(&tree(vec![root, mid, leaf]), "leaf", "press");
        let ids: Vec<(String, String)> = path
            .iter()
            .map(|(phase, id)| (phase.clone(), id.clone()))
            .collect();
        assert_eq!(
            ids,
            vec![
                (PHASE_CAPTURE.into(), "root".into()),
                (PHASE_CAPTURE.into(), "mid".into()),
                (PHASE_TARGET.into(), "leaf".into()),
                (PHASE_BUBBLE.into(), "mid".into()),
                (PHASE_BUBBLE.into(), "root".into()),
            ]
        );
        assert!(dispatch(&tree(vec![node("root", None)]), "ghost", "press").is_empty());
    }

    #[test]
    fn hit_test_rejects_non_finite_point() {
        let layout = layout_tree(&tree(vec![node("root", None)])).expect("solves");
        assert_eq!(
            hit_test(&layout, &tree(vec![node("root", None)]), [f64::NAN, 0.0]),
            None
        );
    }
}
