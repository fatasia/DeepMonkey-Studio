//! Product window UIA attachment. Its tree follows the published content only.
use super::NativeApp;
use deep_engine_native::native_ui::{
    AccessibilityNode, RetainedUiRole, SemanticsTree, UiaBridge, legend_semantics_tree,
};
use std::sync::Arc;
use winit::{
    raw_window_handle::{HasWindowHandle, RawWindowHandle},
    window::Window,
};

pub(super) struct WindowAccessibility {
    // Keep the HWND alive until the subclass has detached.
    bridge: UiaBridge,
    _window: Arc<Window>,
    tree: SemanticsTree,
}

fn semantics(app: &NativeApp) -> SemanticsTree {
    let mut tree = SemanticsTree {
        root_id: "deep-native-window".into(),
        nodes: vec![AccessibilityNode {
            id: "deep-native-window".into(),
            role: RetainedUiRole::Application,
            name: Some("Deep Engine".into()),
            value: app
                .content
                .active()
                .runtime_package()
                .map(|package| format!("{} {}", package.package_id, package.package_version)),
            children: Vec::new(),
            virtual_count: None,
        }],
    };
    if let Some(chart) = app.content.active().chart.as_ref() {
        tree.nodes[0].children.push("active-chart".into());
        tree.nodes.push(AccessibilityNode {
            id: "active-chart".into(),
            role: RetainedUiRole::Region,
            name: Some(deep_engine_native::chart::linking::chart_summary(
                chart.source(),
            )),
            value: None,
            children: Vec::new(),
            virtual_count: None,
        });
    }
    if let Some(legend) = super::window_events::legend_snapshot(app)
        && !legend.items.is_empty()
        && let Ok(legend) = legend_semantics_tree(&legend)
    {
        tree.nodes[0].children.push(legend.root_id);
        tree.nodes.extend(legend.nodes);
    }
    tree
}

pub(super) fn attach(app: &mut NativeApp) {
    if app.accessibility.is_some() {
        return;
    }
    let Some(window) = app.window.clone() else {
        return;
    };
    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return;
    };
    let tree = semantics(app);
    match UiaBridge::attach(handle.hwnd.get(), tree.clone()) {
        Ok(bridge) => {
            app.accessibility = Some(WindowAccessibility {
                bridge,
                _window: window,
                tree,
            })
        }
        Err(error) => eprintln!("native accessibility attach failed: {error}"),
    }
}

pub(super) fn sync(app: &mut NativeApp) {
    let tree = semantics(app);
    let Some(host) = app.accessibility.as_mut() else {
        return;
    };
    if tree == host.tree {
        return;
    }
    // replace_semantics publishes under a lock before raising its notification.
    // Keep this snapshot even if OS event delivery fails, avoiding a busy retry loop.
    if let Err(error) = host.bridge.replace_semantics(tree.clone()) {
        eprintln!("native accessibility update failed: {error}");
    }
    host.tree = tree;
}

#[cfg(test)]
#[path = "accessibility_tests.rs"]
mod tests;
