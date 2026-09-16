//! Native reader/validator for the TypeScript `RetainedUiTree` contract
//! (retained UI v1). This is the U01 cross-language golden: the same tree
//! must validate identically in TS and Rust before the native runtime grows
//! layout/paint/event stages on top.

use serde::{Deserialize, Serialize};

pub const RETAINED_UI_SCHEMA_VERSION: u32 = 1;
pub const RETAINED_UI_BUDGETS: RetainedUiBudgets = RetainedUiBudgets {
    nodes: 65_536,
    children: 262_144,
    tree_depth: 256,
    coordinate: 16_777_216.0,
    diagnostics: 256,
};

#[derive(Debug, Clone, Copy)]
pub struct RetainedUiBudgets {
    pub nodes: usize,
    pub children: usize,
    pub tree_depth: usize,
    pub coordinate: f64,
    diagnostics: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RetainedUiNodeKind {
    Container,
    Text,
    Image,
    Viewport,
    Chart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetainedUiLayoutMode {
    Absolute,
    Stack,
    FlexRow,
    FlexColumn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RetainedUiAlign {
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RetainedUiPointerEvents {
    Auto,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RetainedUiStyle {
    pub layout: RetainedUiLayoutMode,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_height: Option<f64>,
    pub padding: f64,
    pub gap: f64,
    pub grow: f64,
    pub align: RetainedUiAlign,
    pub clip: bool,
    pub visible: bool,
    pub opacity: f64,
    pub pointer_events: RetainedUiPointerEvents,
    pub z_index: i32,
    pub background: Option<[f64; 4]>,
    pub foreground: [f64; 4],
    pub border_color: Option<[f64; 4]>,
    pub border_width: f64,
    pub corner_radius: f64,
    pub font_id: Option<String>,
    pub font_size: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RetainedUiContent {
    Container,
    Text { text: String },
    Image { asset_id: String },
    Viewport { surface_id: String },
    Chart { chart_spec_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RetainedUiRole {
    None,
    Text,
    Img,
    Button,
    Region,
    Application,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RetainedUiA11y {
    pub role: RetainedUiRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RetainedUiNode {
    pub id: String,
    pub revision: u64,
    pub parent_id: Option<String>,
    pub children: Vec<String>,
    pub style: RetainedUiStyle,
    pub content: RetainedUiContent,
    pub a11y: RetainedUiA11y,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RetainedUiTree {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub width: f64,
    pub height: f64,
    pub root_id: String,
    pub nodes: Vec<RetainedUiNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetainedUiDiagnosticCode {
    InvalidJson,
    InvalidSchema,
    InvalidValue,
    UnknownField,
    BudgetExceeded,
    DuplicateId,
    MissingReference,
    ParentChildMismatch,
    Cycle,
    Unreachable,
    StaleRevision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedUiDiagnostic {
    pub code: RetainedUiDiagnosticCode,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedUiValidation {
    pub valid: bool,
    pub diagnostics: Vec<RetainedUiDiagnostic>,
}

/// Structural (post-deserialize) validation mirroring the TS rules: unique
/// ids, root extent, parent/child consistency, cycles, reachability. JSON
/// shape errors (unknown fields, non-plain values) are caught by serde with
/// `deny_unknown_fields` before this runs.
fn add_diagnostic(
    diagnostics: &mut Vec<RetainedUiDiagnostic>,
    code: RetainedUiDiagnosticCode,
    path: &str,
    message: &str,
) {
    if diagnostics.len() < RETAINED_UI_BUDGETS.diagnostics {
        diagnostics.push(RetainedUiDiagnostic {
            code,
            path: path.into(),
            message: message.into(),
        });
    }
}

pub fn validate_retained_ui_tree(tree: &RetainedUiTree) -> RetainedUiValidation {
    let mut diagnostics = Vec::new();

    if tree.schema_version != RETAINED_UI_SCHEMA_VERSION {
        add_diagnostic(
            &mut diagnostics,
            RetainedUiDiagnosticCode::InvalidSchema,
            "$.schemaVersion",
            "Expected retained UI schema version 1.",
        );
    }
    if tree.nodes.len() > RETAINED_UI_BUDGETS.nodes {
        add_diagnostic(
            &mut diagnostics,
            RetainedUiDiagnosticCode::BudgetExceeded,
            "$.nodes",
            "Node budget exceeded.",
        );
    }
    let child_total: usize = tree.nodes.iter().map(|node| node.children.len()).sum();
    if child_total > RETAINED_UI_BUDGETS.children {
        add_diagnostic(
            &mut diagnostics,
            RetainedUiDiagnosticCode::BudgetExceeded,
            "$.nodes",
            "Child-reference budget exceeded.",
        );
    }

    // Detect duplicates from the source sequence before indexing. A HashMap
    // collapses equal keys, which used to hide duplicates and could select a
    // different node for later structural checks.
    let mut seen_node_ids = std::collections::HashSet::with_capacity(tree.nodes.len());
    let duplicate_node_ids = tree
        .nodes
        .iter()
        .map(|node| !seen_node_ids.insert(node.id.as_str()))
        .collect::<Vec<_>>();
    let mut nodes = std::collections::HashMap::with_capacity(tree.nodes.len());
    let mut unique_nodes = Vec::with_capacity(tree.nodes.len());
    for node in &tree.nodes {
        // Match the TypeScript validator: after reporting a duplicate, retain
        // the first source node as the deterministic structural representative.
        if let std::collections::hash_map::Entry::Vacant(entry) = nodes.entry(node.id.as_str()) {
            entry.insert(node);
            unique_nodes.push(node);
        }
    }
    for (index, node) in tree.nodes.iter().enumerate() {
        let path = format!("$.nodes[{index}]");
        if duplicate_node_ids[index] {
            add_diagnostic(
                &mut diagnostics,
                RetainedUiDiagnosticCode::DuplicateId,
                &format!("{path}.id"),
                "Node id must be globally unique.",
            );
        }
        let mut unique = std::collections::HashSet::new();
        if !node.children.iter().all(|child| unique.insert(child)) {
            add_diagnostic(
                &mut diagnostics,
                RetainedUiDiagnosticCode::DuplicateId,
                &format!("{path}.children"),
                "Child ids must be unique per parent.",
            );
        }
        if !matches!(node.content, RetainedUiContent::Container) && !node.children.is_empty() {
            add_diagnostic(
                &mut diagnostics,
                RetainedUiDiagnosticCode::InvalidValue,
                &format!("{path}.children"),
                "Only container nodes may have children.",
            );
        }
    }

    let Some(root) = nodes.get(tree.root_id.as_str()).copied() else {
        add_diagnostic(
            &mut diagnostics,
            RetainedUiDiagnosticCode::MissingReference,
            "$.rootId",
            "Root node is missing.",
        );
        return finish(diagnostics);
    };
    if root.parent_id.is_some() {
        add_diagnostic(
            &mut diagnostics,
            RetainedUiDiagnosticCode::ParentChildMismatch,
            "$.rootId",
            "Root parent must be null.",
        );
    }
    if root.style.x != 0.0
        || root.style.y != 0.0
        || root.style.width != tree.width
        || root.style.height != tree.height
    {
        add_diagnostic(
            &mut diagnostics,
            RetainedUiDiagnosticCode::InvalidValue,
            "$.rootId",
            "Root style must start at zero and match the tree extent.",
        );
    }

    for node in &unique_nodes {
        if node.id != tree.root_id && node.parent_id.is_none() {
            add_diagnostic(
                &mut diagnostics,
                RetainedUiDiagnosticCode::ParentChildMismatch,
                &format!("$.nodes.{}.parentId", node.id),
                "Only root may have null parent.",
            );
        }
        if let Some(parent_id) = &node.parent_id {
            match nodes.get(parent_id.as_str()) {
                None => add_diagnostic(
                    &mut diagnostics,
                    RetainedUiDiagnosticCode::MissingReference,
                    &format!("$.nodes.{}.parentId", node.id),
                    "Parent node is missing.",
                ),
                Some(parent) => {
                    if !parent.children.contains(&node.id) {
                        add_diagnostic(
                            &mut diagnostics,
                            RetainedUiDiagnosticCode::ParentChildMismatch,
                            &format!("$.nodes.{}.parentId", node.id),
                            "Parent must contain this child id.",
                        );
                    }
                }
            }
        }
        for child_id in &node.children {
            match nodes.get(child_id.as_str()) {
                None => add_diagnostic(
                    &mut diagnostics,
                    RetainedUiDiagnosticCode::MissingReference,
                    &format!("$.nodes.{}.children", node.id),
                    "Missing child node.",
                ),
                Some(child) => {
                    if child.parent_id.as_deref() != Some(node.id.as_str()) {
                        add_diagnostic(
                            &mut diagnostics,
                            RetainedUiDiagnosticCode::ParentChildMismatch,
                            &format!("$.nodes.{}.children", node.id),
                            "Child points to another parent.",
                        );
                    }
                }
            }
        }
    }

    // Cycle + reachability: colored DFS (white/gray/black). A gray target on
    // the current path is a back edge — a cycle.
    let mut visiting = std::collections::HashSet::new();
    let mut visited = std::collections::HashSet::new();
    walk(
        &tree.root_id,
        0,
        &nodes,
        &mut visiting,
        &mut visited,
        &mut diagnostics,
    );
    for node in &unique_nodes {
        if !visited.contains(&node.id) {
            add_diagnostic(
                &mut diagnostics,
                RetainedUiDiagnosticCode::Unreachable,
                &format!("$.nodes.{}", node.id),
                "Node is unreachable from root.",
            );
        }
    }
    finish(diagnostics)
}

/// On-path DFS helper: reports cycles and depth-budget violations, and fills
/// `visited` with every node reachable from the start id.
fn walk(
    id: &str,
    depth: usize,
    nodes: &std::collections::HashMap<&str, &RetainedUiNode>,
    visiting: &mut std::collections::HashSet<String>,
    visited: &mut std::collections::HashSet<String>,
    diagnostics: &mut Vec<RetainedUiDiagnostic>,
) {
    if depth > RETAINED_UI_BUDGETS.tree_depth {
        add_diagnostic(
            diagnostics,
            RetainedUiDiagnosticCode::BudgetExceeded,
            &format!("$.nodes.{id}"),
            "Tree depth budget exceeded.",
        );
        return;
    }
    let Some(node) = nodes.get(id) else {
        return;
    };
    visiting.insert(id.to_string());
    for child in &node.children {
        if visiting.contains(child) {
            add_diagnostic(
                diagnostics,
                RetainedUiDiagnosticCode::Cycle,
                &format!("$.nodes.{child}"),
                "Node graph contains a cycle.",
            );
        } else if !visited.contains(child) {
            walk(child, depth + 1, nodes, visiting, visited, diagnostics);
        }
    }
    visiting.remove(id);
    visited.insert(id.to_string());
}

fn finish(diagnostics: Vec<RetainedUiDiagnostic>) -> RetainedUiValidation {
    RetainedUiValidation {
        valid: diagnostics.is_empty(),
        diagnostics,
    }
}
