//! P1-16 uia_bridge 纯逻辑层测试:角色→ControlType 映射、fail-closed 导航、
//! attach/replace 校验(空树/缺根/环)。窗口与 COM 路径由 `--smoke-uia`
//! 端到端覆盖,这里保证任何平台都能跑核心边界。

use super::{
    UiaBridgeError, UiaControlType, UiaNavigateDirection, control_type_for, navigate_from,
    validate_semantics,
};
use crate::native_ui::accessibility::{AccessibilityNode, SemanticsTree};
use crate::native_ui::retained_ui::RetainedUiRole;

fn node(id: &str, _parent: Option<&str>, role: RetainedUiRole) -> AccessibilityNode {
    AccessibilityNode {
        id: id.into(),
        role,
        name: Some(id.into()),
        value: None,
        children: Vec::new(),
        virtual_count: None,
    }
}

fn chart_tree() -> SemanticsTree {
    let mut root = node("root", None, RetainedUiRole::Application);
    root.children = vec!["chart".into(), "legend".into(), "status".into()];
    let mut legend = node("legend", Some("root"), RetainedUiRole::Region);
    legend.children = vec![
        "legend:0:toggle:series-a".into(),
        "legend:0:toggle:series-b".into(),
    ];
    SemanticsTree {
        root_id: "root".into(),
        nodes: vec![
            root,
            node("chart", Some("root"), RetainedUiRole::Region),
            legend,
            node(
                "legend:0:toggle:series-a",
                Some("legend"),
                RetainedUiRole::Button,
            ),
            node(
                "legend:0:toggle:series-b",
                Some("legend"),
                RetainedUiRole::Button,
            ),
            node("status", Some("root"), RetainedUiRole::Text),
        ],
    }
}

#[test]
fn control_types_follow_roles_with_legend_prefix_override() {
    assert_eq!(
        control_type_for(RetainedUiRole::Button, "ok-btn"),
        UiaControlType::Button
    );
    assert_eq!(
        control_type_for(RetainedUiRole::Region, "chart"),
        UiaControlType::Group
    );
    assert_eq!(
        control_type_for(RetainedUiRole::Text, "status"),
        UiaControlType::Text
    );
    assert_eq!(
        control_type_for(RetainedUiRole::Img, "preview"),
        UiaControlType::Image
    );
    assert_eq!(
        control_type_for(RetainedUiRole::Application, "root"),
        UiaControlType::Pane
    );
    assert_eq!(
        control_type_for(RetainedUiRole::None, "widget"),
        UiaControlType::Custom
    );
    // 图例项按 chart_a11y::legend_item_id 的 id 约定读作 ListItem,即使角色是 Button。
    assert_eq!(
        control_type_for(RetainedUiRole::Button, "legend:0:toggle:series-a"),
        UiaControlType::ListItem
    );
}

#[test]
fn control_type_ids_match_windows_uia_contract() {
    assert_eq!(UiaControlType::Button.id(), 50000);
    assert_eq!(UiaControlType::Image.id(), 50006);
    assert_eq!(UiaControlType::ListItem.id(), 50007);
    assert_eq!(UiaControlType::Text.id(), 50020);
    assert_eq!(UiaControlType::Custom.id(), 50025);
    assert_eq!(UiaControlType::Group.id(), 50026);
    assert_eq!(UiaControlType::Pane.id(), 50033);
}

#[test]
fn navigate_walks_neighbors_fail_closed() {
    let tree = chart_tree();
    let nav = |from: &str, direction| navigate_from(&tree, from, direction);
    assert_eq!(
        nav("legend", UiaNavigateDirection::Parent).as_deref(),
        Some("root")
    );
    assert_eq!(
        nav("root", UiaNavigateDirection::FirstChild).as_deref(),
        Some("chart")
    );
    assert_eq!(
        nav("root", UiaNavigateDirection::LastChild).as_deref(),
        Some("status")
    );
    assert_eq!(
        nav("chart", UiaNavigateDirection::NextSibling).as_deref(),
        Some("legend")
    );
    assert_eq!(
        nav(
            "legend:0:toggle:series-b",
            UiaNavigateDirection::PreviousSibling
        )
        .as_deref(),
        Some("legend:0:toggle:series-a")
    );
    // 边界即 None:根没有父,首项没有前驱,末项没有后继,叶子没有子。
    assert_eq!(nav("root", UiaNavigateDirection::Parent), None);
    assert_eq!(
        nav(
            "legend:0:toggle:series-a",
            UiaNavigateDirection::PreviousSibling
        ),
        None
    );
    assert_eq!(nav("status", UiaNavigateDirection::NextSibling), None);
    assert_eq!(nav("status", UiaNavigateDirection::FirstChild), None);
    // 越界/悬空一律 fail closed,不猜邻居。
    assert_eq!(nav("ghost", UiaNavigateDirection::Parent), None);
}

#[test]
fn dangling_child_ids_never_navigate() {
    let mut root = node("root", None, RetainedUiRole::Application);
    root.children = vec!["ghost-child".into()];
    let tree = SemanticsTree {
        root_id: "root".into(),
        nodes: vec![root],
    };
    assert_eq!(
        navigate_from(&tree, "root", UiaNavigateDirection::FirstChild),
        None
    );
}

#[test]
fn validation_rejects_empty_rootless_and_cyclic_trees() {
    assert_eq!(validate_semantics(&chart_tree()), Ok(()));

    let empty = SemanticsTree {
        root_id: "root".into(),
        nodes: Vec::new(),
    };
    assert_eq!(validate_semantics(&empty), Err(UiaBridgeError::EmptyTree));

    let rootless = SemanticsTree {
        root_id: "ghost".into(),
        nodes: vec![node("root", None, RetainedUiRole::Application)],
    };
    assert_eq!(
        validate_semantics(&rootless),
        Err(UiaBridgeError::RootMissing)
    );

    let mut a = node("a", None, RetainedUiRole::Application);
    a.children = vec!["b".into()];
    let mut b = node("b", Some("a"), RetainedUiRole::Region);
    b.children = vec!["a".into()];
    let cyclic = SemanticsTree {
        root_id: "a".into(),
        nodes: vec![a, b],
    };
    assert_eq!(validate_semantics(&cyclic), Err(UiaBridgeError::CyclicTree));
}

#[test]
fn error_messages_state_the_actionable_cause() {
    assert_eq!(
        UiaBridgeError::WindowThreadMismatch.to_string(),
        "attach must be called on the thread that owns the window"
    );
    assert!(
        UiaBridgeError::EventFailed("S_FALSE".into())
            .to_string()
            .contains("COM initialized")
    );
}
