//! RetainedUiTree structural validation golden (moved from retained_ui.rs to keep the module under the 500-line review line).

use deep_engine_native::native_ui::*;

fn root_node(width: f64, height: f64) -> RetainedUiNode {
    RetainedUiNode {
        id: "root".into(),
        revision: 0,
        parent_id: None,
        children: vec!["child".into()],
        style: RetainedUiStyle {
            layout: RetainedUiLayoutMode::FlexColumn,
            x: 0.0,
            y: 0.0,
            width,
            height,
            min_width: None,
            max_width: None,
            min_height: None,
            max_height: None,
            padding: 0.0,
            gap: 0.0,
            grow: 0.0,
            align: RetainedUiAlign::Start,
            clip: true,
            visible: true,
            opacity: 1.0,
            pointer_events: RetainedUiPointerEvents::Auto,
            z_index: 0,
            background: None,
            foreground: [1.0, 1.0, 1.0, 1.0],
            border_color: None,
            border_width: 0.0,
            corner_radius: 0.0,
            font_id: None,
            font_size: 14.0,
        },
        content: RetainedUiContent::Container,
        a11y: RetainedUiA11y {
            role: RetainedUiRole::Application,
            label: None,
            value: None,
        },
    }
}

fn child_node() -> RetainedUiNode {
    let mut node = root_node(10.0, 10.0);
    node.id = "child".into();
    node.parent_id = Some("root".into());
    node.children.clear();
    node.content = RetainedUiContent::Text {
        text: "状态: 运行中".into(),
    };
    node.a11y.role = RetainedUiRole::Text;
    node
}

fn tree() -> RetainedUiTree {
    RetainedUiTree {
        schema_version: 1,
        id: "panel".into(),
        revision: 1,
        width: 100.0,
        height: 50.0,
        root_id: "root".into(),
        nodes: vec![root_node(100.0, 50.0), child_node()],
    }
}

#[test]
fn valid_tree_passes_and_roundtrips_through_json() {
    let tree = tree();
    let validation = validate_retained_ui_tree(&tree);
    assert!(validation.valid, "{:?}", validation.diagnostics);
    let json = serde_json::to_string(&tree).expect("serialize");
    let round: RetainedUiTree = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round, tree);
}

#[test]
fn unknown_fields_fail_closed_at_deserialize() {
    let mut tree = tree();
    tree.nodes[1].revision += 1;
    let json = serde_json::to_string(&tree).expect("serialize");
    let poisoned = json.replacen("\"revision\":1", "\"revision\":1,\"surprise\":true", 1);
    assert!(serde_json::from_str::<RetainedUiTree>(&poisoned).is_err());
}

#[test]
fn duplicate_node_ids_are_reported_before_indexing() {
    let mut duplicated = tree();
    let mut conflicting_root = root_node(100.0, 50.0);
    conflicting_root.parent_id = Some("ghost".into());
    conflicting_root.children.clear();
    duplicated.nodes.push(conflicting_root);

    let validation = validate_retained_ui_tree(&duplicated);
    assert!(!validation.valid);
    assert!(validation.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == RetainedUiDiagnosticCode::DuplicateId
            && diagnostic.path == "$.nodes[2].id"
            && diagnostic.message == "Node id must be globally unique."
    }));
    // The first source node is the structural representative, matching the
    // TypeScript validator; the conflicting duplicate must not redefine root.
    assert!(!validation.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == RetainedUiDiagnosticCode::ParentChildMismatch
            && diagnostic.path == "$.rootId"
    }));
}

#[test]
fn cycles_missing_children_and_bad_root_extent_are_structural_diagnostics() {
    let mut cyclic = tree();
    cyclic.nodes[1].children.push("root".into());
    let validation = validate_retained_ui_tree(&cyclic);
    assert!(!validation.valid);
    assert!(
        validation
            .diagnostics
            .iter()
            .any(|d| d.code == RetainedUiDiagnosticCode::Cycle)
            || validation
                .diagnostics
                .iter()
                .any(|d| d.code == RetainedUiDiagnosticCode::Unreachable)
    );

    let mut orphan = tree();
    orphan.nodes[1].parent_id = Some("ghost".into());
    let validation = validate_retained_ui_tree(&orphan);
    assert!(
        validation
            .diagnostics
            .iter()
            .any(|d| d.code == RetainedUiDiagnosticCode::MissingReference)
    );

    let mut bad_root = tree();
    bad_root.nodes[0].style.width = 99.0;
    let validation = validate_retained_ui_tree(&bad_root);
    assert!(
        validation
            .diagnostics
            .iter()
            .any(|d| d.code == RetainedUiDiagnosticCode::InvalidValue)
    );
}
