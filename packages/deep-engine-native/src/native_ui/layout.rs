//! Layout solver for the retained UI tree (U02). Mirrors the TypeScript
//! authority `packages/deep-engine/src/retainedUi/layout.ts` frame-for-frame:
//! every child is placed relative to its parent's padding box and its own
//! `style.x/y` offset is applied in every layout mode (including flex, where
//! it stacks on top of the main-axis cursor). Two deliberate differences:
//! invisible subtrees are pruned here (the TS solver emits frames for them
//! and lets hit-testing filter), and non-finite input fails closed instead
//! of relying on the TS clamp.

use std::collections::HashMap;

use super::retained_ui::{
    RETAINED_UI_BUDGETS, RetainedUiAlign, RetainedUiLayoutMode, RetainedUiNode, RetainedUiTree,
};

/// A solved rectangle in world coordinates plus the paint-order metadata the
/// event stage needs. `clip` is the accumulated ancestor scissor (already
/// intersected with this node's rect) or `None` when nothing clips above.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedUiFrame {
    pub id: String,
    pub rect: [f64; 4],
    pub clip: Option<[f64; 4]>,
    pub order: usize,
    pub z_index: i32,
    pub depth: usize,
}

/// Layout output: quick node-id lookups (`rects`/`depths`) plus the
/// tree-order `frames` sequence consumed by painting and hit testing.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedUiLayout {
    pub rects: HashMap<String, [f64; 4]>,
    pub depths: HashMap<String, usize>,
    pub frames: Vec<RetainedUiFrame>,
}

/// Solves world-space rectangles for every visible node. Assumes the tree
/// passed structural validation (unique ids, parent/child consistency, no
/// cycles) but still defends against depth blowups and non-finite numbers.
pub fn layout_tree(tree: &RetainedUiTree) -> Result<RetainedUiLayout, String> {
    if ![tree.width, tree.height].iter().all(|v| v.is_finite()) {
        return Err("tree extent (width/height) must be finite".into());
    }
    let nodes: HashMap<&str, &RetainedUiNode> = tree
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let root = nodes.get(tree.root_id.as_str()).ok_or_else(|| {
        format!(
            "root node '{}' is missing; run validate_retained_ui_tree first",
            tree.root_id
        )
    })?;
    if let Some(field) = non_finite_style_field(root) {
        return Err(format!(
            "node '{}' has non-finite layout field '{field}'",
            root.id
        ));
    }

    let mut layout = RetainedUiLayout {
        rects: HashMap::new(),
        depths: HashMap::new(),
        frames: Vec::new(),
    };
    let mut order = 0usize;
    visit(
        root,
        [0.0, 0.0, tree.width, tree.height],
        None,
        0,
        &mut order,
        &nodes,
        &mut layout,
    )?;
    Ok(layout)
}

fn visit(
    node: &RetainedUiNode,
    rect: [f64; 4],
    inherited_clip: Option<[f64; 4]>,
    depth: usize,
    order: &mut usize,
    nodes: &HashMap<&str, &RetainedUiNode>,
    layout: &mut RetainedUiLayout,
) -> Result<(), String> {
    if depth > RETAINED_UI_BUDGETS.tree_depth {
        return Err(format!(
            "tree depth exceeds {} at node '{}'; run validate_retained_ui_tree first",
            RETAINED_UI_BUDGETS.tree_depth, node.id
        ));
    }
    // Invisible nodes are skipped with their whole subtree: no rectangles,
    // no hit targets, no paint work.
    if !node.style.visible {
        return Ok(());
    }
    let clip = if node.style.clip {
        Some(intersect(inherited_clip, rect))
    } else {
        inherited_clip
    };
    layout.rects.insert(node.id.clone(), rect);
    layout.depths.insert(node.id.clone(), depth);
    layout.frames.push(RetainedUiFrame {
        id: node.id.clone(),
        rect,
        clip,
        order: *order,
        z_index: node.style.z_index,
        depth,
    });
    *order += 1;

    let padding = node.style.padding;
    let inner = [
        rect[0] + padding,
        rect[1] + padding,
        (rect[2] - 2.0 * padding).max(0.0),
        (rect[3] - 2.0 * padding).max(0.0),
    ];
    let children: Vec<&RetainedUiNode> = node
        .children
        .iter()
        .map(|id| {
            nodes
                .get(id.as_str())
                .copied()
                .ok_or_else(|| format!("node '{}' references missing child '{id}'", node.id))
        })
        .collect::<Result<_, _>>()?;
    let row = node.style.layout == RetainedUiLayoutMode::FlexRow;
    let flex = row || node.style.layout == RetainedUiLayoutMode::FlexColumn;
    let main_size = if row { inner[2] } else { inner[3] };
    let gap_total = node.style.gap * children.len().saturating_sub(1) as f64;
    // Fixed (basis) sizes along the main axis after min/max clamping.
    let basis: f64 = children
        .iter()
        .map(|child| {
            let s = &child.style;
            if row {
                clamp_size(s.width, s.min_width, s.max_width)
            } else {
                clamp_size(s.height, s.min_height, s.max_height)
            }
        })
        .sum();
    let total_grow: f64 = children.iter().map(|child| child.style.grow).sum();
    // Leftover after fixed sizes and gaps; only flex distributes it, and
    // only proportionally to grow.
    let extra = (main_size - basis - gap_total).max(0.0);
    let mut cursor = if row { inner[0] } else { inner[1] };

    for child in &children {
        let s = &child.style;
        let mut width = clamp_size(s.width, s.min_width, s.max_width);
        let mut height = clamp_size(s.height, s.min_height, s.max_height);
        let mut x = inner[0] + s.x;
        let mut y = inner[1] + s.y;
        if flex {
            let share = if total_grow != 0.0 {
                extra * s.grow / total_grow
            } else {
                0.0
            };
            let (main, min_main, max_main) = if row {
                (width + share, s.min_width, s.max_width)
            } else {
                (height + share, s.min_height, s.max_height)
            };
            let main = clamp_size(main, min_main, max_main);
            let (cross_available, cross_size) = if row {
                (inner[3], height)
            } else {
                (inner[2], width)
            };
            let offset = aligned_offset(node.style.align, cross_available, cross_size);
            if row {
                width = main;
                x = cursor + s.x;
                if node.style.align == RetainedUiAlign::Stretch {
                    height = clamp_size(cross_available, s.min_height, s.max_height);
                }
                y = inner[1] + offset + s.y;
            } else {
                height = main;
                y = cursor + s.y;
                if node.style.align == RetainedUiAlign::Stretch {
                    width = clamp_size(cross_available, s.min_width, s.max_width);
                }
                x = inner[0] + offset + s.x;
            }
            cursor += main + node.style.gap;
        } else if node.style.layout == RetainedUiLayoutMode::Stack {
            // Stack children overlap at their own offsets; alignment
            // positions each child inside the content box (gap is a
            // flex-only axis concept, matching the TS authority).
            if node.style.align == RetainedUiAlign::Stretch {
                width = clamp_size(inner[2], s.min_width, s.max_width);
                height = clamp_size(inner[3], s.min_height, s.max_height);
            } else {
                x += aligned_offset(node.style.align, inner[2], width);
                y += aligned_offset(node.style.align, inner[3], height);
            }
        }
        visit(
            child,
            [x, y, width, height],
            clip,
            depth + 1,
            order,
            nodes,
            layout,
        )?;
    }
    Ok(())
}

/// Mirrors the TS clamp: saturate into `[min ?? 0, max ?? coordinate budget]`.
fn clamp_size(value: f64, min: Option<f64>, max: Option<f64>) -> f64 {
    value
        .max(min.unwrap_or(0.0))
        .min(max.unwrap_or(RETAINED_UI_BUDGETS.coordinate))
}

fn aligned_offset(mode: RetainedUiAlign, available: f64, size: f64) -> f64 {
    match mode {
        RetainedUiAlign::Center => (available - size) / 2.0,
        RetainedUiAlign::End => available - size,
        RetainedUiAlign::Start | RetainedUiAlign::Stretch => 0.0,
    }
}

fn intersect(a: Option<[f64; 4]>, b: [f64; 4]) -> [f64; 4] {
    let Some(a) = a else { return b };
    let [ax, ay, aw, ah] = a;
    let [bx, by, bw, bh] = b;
    let (x, y) = (ax.max(bx), ay.max(by));
    [
        x,
        y,
        ((ax + aw).min(bx + bw) - x).max(0.0),
        ((ay + ah).min(by + bh) - y).max(0.0),
    ]
}

/// Layout-relevant style fields only; paint-only fields (colors, fonts) are
/// not this stage's contract.
fn non_finite_style_field(node: &RetainedUiNode) -> Option<&'static str> {
    let s = &node.style;
    for (name, value) in [
        ("x", s.x),
        ("y", s.y),
        ("width", s.width),
        ("height", s.height),
        ("padding", s.padding),
        ("gap", s.gap),
        ("grow", s.grow),
    ] {
        if !value.is_finite() {
            return Some(name);
        }
    }
    for (name, value) in [
        ("minWidth", s.min_width),
        ("maxWidth", s.max_width),
        ("minHeight", s.min_height),
        ("maxHeight", s.max_height),
    ] {
        if value.is_some_and(|v| !v.is_finite()) {
            return Some(name);
        }
    }
    None
}
