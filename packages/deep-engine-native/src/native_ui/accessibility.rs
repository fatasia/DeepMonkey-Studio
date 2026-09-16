//! U08: accessibility semantics-tree contract. Builds the UI-Automation
//! facing tree from the retained UI tree's `a11y` metadata and maps assistive
//! actions onto the SAME event vocabulary the pointer/keyboard pipeline
//! uses — there is exactly one event system, no separate AT channel.

use crate::native_ui::retained_ui::{RetainedUiContent, RetainedUiRole, RetainedUiTree};

/// One UIA-facing node. `virtual_count` is set for virtualized list/tree
/// containers: assistive tech sees the full row count while only in-viewport
/// rows exist as concrete child nodes (U06 contract).
#[derive(Debug, Clone, PartialEq)]
pub struct AccessibilityNode {
    pub id: String,
    pub role: RetainedUiRole,
    pub name: Option<String>,
    pub value: Option<String>,
    pub children: Vec<String>,
    pub virtual_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticsTree {
    pub root_id: String,
    pub nodes: Vec<AccessibilityNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SemanticsError {
    RootMissing,
    NonTextContentWithoutRole,
}

impl SemanticsTree {
    pub fn node(&self, id: &str) -> Option<&AccessibilityNode> {
        self.nodes.iter().find(|node| node.id == id)
    }

    /// Depth-first walk in tree order (stable for screen readers).
    pub fn walk_ids(&self) -> Vec<String> {
        let mut order = Vec::new();
        let mut stack = vec![self.root_id.clone()];
        while let Some(id) = stack.pop() {
            let Some(node) = self.node(&id) else { continue };
            order.push(id);
            for child in node.children.iter().rev() {
                stack.push(child.clone());
            }
        }
        order
    }
}

/// Projects the retained tree into a semantics tree. Content kinds without
/// an explicit role fall back to sensible defaults (text→Text, image→Img,
/// viewport/chart→Region) instead of vanishing from assistive tech.
pub fn build_semantics_tree(tree: &RetainedUiTree) -> Result<SemanticsTree, SemanticsError> {
    let nodes = tree
        .nodes
        .iter()
        .map(|node| {
            let fallback_role = match &node.content {
                RetainedUiContent::Container => RetainedUiRole::Region,
                RetainedUiContent::Text { .. } => RetainedUiRole::Text,
                RetainedUiContent::Image { .. } => RetainedUiRole::Img,
                RetainedUiContent::Viewport { .. } | RetainedUiContent::Chart { .. } => {
                    RetainedUiRole::Region
                }
            };
            let role = if node.a11y.role == RetainedUiRole::None {
                fallback_role
            } else {
                node.a11y.role
            };
            AccessibilityNode {
                id: node.id.clone(),
                role,
                name: node.a11y.label.clone(),
                value: node.a11y.value.clone(),
                children: node.children.clone(),
                // Virtualization is expressed by the runtime when the child
                // count is a viewport window of a larger logical list; the
                // contract keeps the slot so UIA properties can be filled.
                virtual_count: None,
            }
        })
        .collect();
    let semantics = SemanticsTree {
        root_id: tree.root_id.clone(),
        nodes,
    };
    if semantics.node(&tree.root_id).is_none() {
        return Err(SemanticsError::RootMissing);
    }
    Ok(semantics)
}

/// Assistive-tech actions map onto the same event strings the pointer and
/// keyboard pipelines dispatch — one reducer, no parallel command path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiAAction {
    Invoke,
    Focus,
    SetValue(String),
}

pub fn map_action_to_event(action: &UiAAction, node_id: &str) -> String {
    match action {
        UiAAction::Invoke => format!("a11y:invoke:{node_id}"),
        UiAAction::Focus => format!("a11y:focus:{node_id}"),
        UiAAction::SetValue(value) => format!("a11y:set-value:{node_id}:{value}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_ui::retained_ui::{
        RetainedUiA11y, RetainedUiContent, RetainedUiNode, RetainedUiStyle, RetainedUiTree,
    };

    fn minimal_node(id: &str, parent: Option<&str>, role: RetainedUiRole) -> RetainedUiNode {
        RetainedUiNode {
            id: id.into(),
            revision: 0,
            parent_id: parent.map(str::to_owned),
            children: Vec::new(),
            style: RetainedUiStyle {
                layout: crate::native_ui::retained_ui::RetainedUiLayoutMode::Absolute,
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
                min_width: None,
                max_width: None,
                min_height: None,
                max_height: None,
                padding: 0.0,
                gap: 0.0,
                grow: 0.0,
                align: crate::native_ui::retained_ui::RetainedUiAlign::Start,
                clip: false,
                visible: true,
                opacity: 1.0,
                pointer_events: crate::native_ui::retained_ui::RetainedUiPointerEvents::Auto,
                z_index: 0,
                background: None,
                foreground: [1.0; 4],
                border_color: None,
                border_width: 0.0,
                corner_radius: 0.0,
                font_id: None,
                font_size: 14.0,
            },
            content: RetainedUiContent::Container,
            a11y: RetainedUiA11y {
                role,
                label: Some(id.into()),
                value: None,
            },
        }
    }

    #[test]
    fn semantics_tree_projects_roles_and_walks_in_order() {
        let mut root = minimal_node("root", None, RetainedUiRole::Application);
        root.children.push("child".into());
        let tree = RetainedUiTree {
            schema_version: 1,
            id: "a11y-tree".into(),
            revision: 1,
            width: 100.0,
            height: 50.0,
            root_id: "root".into(),
            nodes: vec![
                root,
                minimal_node("child", Some("root"), RetainedUiRole::None),
            ],
        };
        let semantics = build_semantics_tree(&tree).expect("semantics build");
        // Role None falls back from content kind (container → Region).
        assert_eq!(
            semantics.node("child").expect("child").role,
            RetainedUiRole::Region
        );
        assert_eq!(
            semantics.walk_ids(),
            vec!["root".to_string(), "child".to_string()]
        );
    }

    #[test]
    fn actions_map_to_the_shared_event_vocabulary() {
        assert_eq!(
            map_action_to_event(&UiAAction::Invoke, "btn-ok"),
            "a11y:invoke:btn-ok"
        );
        assert_eq!(
            map_action_to_event(&UiAAction::SetValue("42".into()), "slider-1"),
            "a11y:set-value:slider-1:42"
        );
        assert_eq!(
            map_action_to_event(&UiAAction::Focus, "input-2"),
            "a11y:focus:input-2"
        );
    }

    #[test]
    fn missing_root_fails_closed() {
        let mut tree_docs = RetainedUiTree {
            schema_version: 1,
            id: "broken".into(),
            revision: 1,
            width: 10.0,
            height: 10.0,
            root_id: "ghost".into(),
            nodes: vec![minimal_node("root", None, RetainedUiRole::Application)],
        };
        tree_docs.root_id = "ghost".into();
        assert_eq!(
            build_semantics_tree(&tree_docs),
            Err(SemanticsError::RootMissing)
        );
    }
}
