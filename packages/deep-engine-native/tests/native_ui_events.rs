//! Event-stage contract tests (U03 + U04): hit testing, DOM-style dispatch
//! and control state machines. Modules compile here via `#[path]` until mounted.
#![allow(dead_code)]

#[path = "../src/native_ui/retained_ui.rs"]
mod retained_ui;

#[path = "../src/native_ui/layout.rs"]
mod layout;

#[path = "../src/native_ui/events.rs"]
mod events;

#[path = "../src/native_ui/controls.rs"]
mod controls;

use events::{dispatch, hit_test};
use layout::layout_tree;
use retained_ui::{
    RetainedUiA11y, RetainedUiAlign, RetainedUiContent, RetainedUiLayoutMode, RetainedUiNode,
    RetainedUiPointerEvents, RetainedUiRole, RetainedUiStyle, RetainedUiTree,
};

fn style() -> RetainedUiStyle {
    RetainedUiStyle {
        layout: RetainedUiLayoutMode::Absolute,
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

fn node(id: &str, parent: Option<&str>) -> RetainedUiNode {
    RetainedUiNode {
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

fn tree(nodes: Vec<RetainedUiNode>) -> RetainedUiTree {
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

/// Root (100x100) with two overlapping children at (10,10) sized 50x50.
fn overlap_tree() -> RetainedUiTree {
    let mut a = node("a", Some("root"));
    a.style.x = 10.0;
    a.style.y = 10.0;
    a.style.width = 50.0;
    a.style.height = 50.0;
    let mut b = a.clone();
    b.id = "b".into();
    let mut root = node("root", None);
    root.children = vec!["a".into(), "b".into()];
    tree(vec![root, a, b])
}

#[test]
fn z_index_wins_then_later_tree_order() {
    let layout = layout_tree(&overlap_tree()).expect("solves");
    // Equal z: later sibling (b) sits on top.
    assert_eq!(
        hit_test(&layout, &overlap_tree(), [30.0, 30.0]).as_deref(),
        Some("b")
    );
    // Higher z wins regardless of tree order.
    let mut ranked = overlap_tree();
    ranked.nodes[2].style.z_index = -1; // b below a
    let layout = layout_tree(&ranked).expect("solves");
    assert_eq!(
        hit_test(&layout, &ranked, [30.0, 30.0]).as_deref(),
        Some("a")
    );
    assert_eq!(
        hit_test(&layout, &ranked, [99.0, 30.0]).as_deref(),
        Some("root")
    );
}

#[test]
fn pointer_events_none_is_transparent() {
    let mut t = overlap_tree();
    t.nodes[2].style.z_index = 9;
    t.nodes[2].style.pointer_events = RetainedUiPointerEvents::None;
    let layout = layout_tree(&t).expect("solves");
    assert_eq!(hit_test(&layout, &t, [30.0, 30.0]).as_deref(), Some("a"));
}

#[test]
fn invisible_and_fully_transparent_are_not_hittable() {
    let mut hidden = overlap_tree();
    hidden.nodes[2].style.visible = false;
    let layout = layout_tree(&hidden).expect("solves");
    assert_eq!(
        hit_test(&layout, &hidden, [30.0, 30.0]).as_deref(),
        Some("a")
    );
    let mut faded = overlap_tree();
    faded.nodes[2].style.opacity = 0.0;
    let layout = layout_tree(&faded).expect("solves");
    assert_eq!(
        hit_test(&layout, &faded, [30.0, 30.0]).as_deref(),
        Some("a")
    );
}

#[test]
fn clip_blocks_hits_outside_the_scissor() {
    let mut root = node("root", None);
    root.style.clip = true;
    let mut child = node("child", Some("root")); // tree extent = small scissor
    child.style.x = 10.0;
    child.style.y = 10.0;
    child.style.width = 50.0;
    child.style.height = 50.0;
    root.children = vec!["child".into()];
    let mut t = tree(vec![root, child]);
    t.width = 20.0;
    let layout = layout_tree(&t).expect("solves");
    assert_eq!(
        hit_test(&layout, &t, [15.0, 15.0]).as_deref(),
        Some("child")
    );
    // Inside the child rect but outside the inherited clip: falls through.
    assert_eq!(hit_test(&layout, &t, [40.0, 40.0]), None);
}

#[test]
fn hit_then_dispatch_walks_ancestors_both_directions() {
    let mut root = node("root", None);
    let mut mid = node("mid", Some("root"));
    let leaf = node("leaf", Some("mid")); // overlaps; wins by tree order
    mid.children = vec!["leaf".into()];
    root.children = vec!["mid".into()];
    let t = tree(vec![root, mid, leaf]);
    let layout = layout_tree(&t).expect("solves");
    let target = hit_test(&layout, &t, [50.0, 50.0]).expect("hits leaf");
    let path = dispatch(&t, &target, "press");
    let expect = [
        "capture:root",
        "capture:mid",
        "target:leaf",
        "bubble:mid",
        "bubble:root",
    ];
    let got: Vec<String> = path.iter().map(|(p, id)| format!("{p}:{id}")).collect();
    assert_eq!(got, expect);
}

mod control_machines {
    use crate::controls::{
        Button, Checkbox, ControlEvent, ControlResponse as R, Select, Slider, Toggle,
    };

    #[test]
    fn button_ignores_disabled_and_dedups_double_press() {
        let mut button = Button::default();
        button.disabled = true;
        assert_eq!(button.handle(&ControlEvent::Press), None);
        assert_eq!(button.handle(&ControlEvent::Release), None);
        button.disabled = false;
        button.loading = true;
        assert_eq!(button.handle(&ControlEvent::Press), None);
        button.loading = false;
        assert_eq!(button.handle(&ControlEvent::Press), None);
        assert_eq!(button.handle(&ControlEvent::Release), Some(R::Clicked));
        assert_eq!(button.handle(&ControlEvent::Release), None); // no second click
        button.handle(&ControlEvent::Press);
        button.handle(&ControlEvent::Blur); // blur disarms
        assert_eq!(button.handle(&ControlEvent::Release), None);
    }

    #[test]
    fn focus_transfers_between_controls() {
        let mut toggle = Toggle::default();
        let mut checkbox = Checkbox::default();
        toggle.handle(&ControlEvent::Focus);
        assert!(toggle.focused && !checkbox.focused);
        toggle.handle(&ControlEvent::Blur);
        checkbox.handle(&ControlEvent::Focus);
        assert!(!toggle.focused && checkbox.focused);
        let mut gated = Toggle::default();
        gated.disabled = true;
        gated.handle(&ControlEvent::Focus);
        assert!(!gated.focused);
    }

    #[test]
    fn toggle_flips_once_per_pair_even_when_spammed() {
        let mut toggle = Toggle::default();
        for _ in 0..3 {
            toggle.handle(&ControlEvent::Press);
        }
        assert_eq!(
            toggle.handle(&ControlEvent::Release),
            Some(R::Toggled(true))
        );
        for _ in 0..3 {
            toggle.handle(&ControlEvent::Press);
        }
        assert_eq!(
            toggle.handle(&ControlEvent::Release),
            Some(R::Toggled(false))
        );
    }

    #[test]
    fn select_opens_navigates_and_commits() {
        let mut select = Select {
            option_count: 3,
            ..Select::default()
        };
        assert_eq!(select.handle(&ControlEvent::Press), Some(R::Opened));
        for _ in 0..3 {
            select.handle(&ControlEvent::KeyInput("ArrowDown".into()));
        }
        assert_eq!(select.highlighted_index, 2); // clamped at last option
        select.handle(&ControlEvent::KeyInput("ArrowUp".into()));
        let enter = ControlEvent::KeyInput("Enter".into());
        assert_eq!(select.handle(&enter), Some(R::SelectionChanged(1)));
        assert!(!select.open);
        select.handle(&ControlEvent::Press);
        assert_eq!(
            select.handle(&ControlEvent::KeyInput("Escape".into())),
            Some(R::Closed)
        );
        select.handle(&ControlEvent::Press);
        select.handle(&ControlEvent::Blur); // blur closes without committing
        assert!(!select.open);
    }

    #[test]
    fn slider_clamps_and_snaps_to_step() {
        let mut slider = Slider {
            min: 0.0,
            max: 10.0,
            step: 2.5,
            value: 0.0,
            disabled: false,
            focused: false,
            loading: false,
        };
        assert_eq!(
            slider.handle(&ControlEvent::ValueChange(100.0)),
            Some(R::ValueChanged(10.0))
        );
        assert_eq!(
            slider.handle(&ControlEvent::ValueChange(-5.0)),
            Some(R::ValueChanged(0.0))
        );
        assert_eq!(
            slider.handle(&ControlEvent::ValueChange(3.3)),
            Some(R::ValueChanged(2.5))
        );
        assert_eq!(
            slider.handle(&ControlEvent::KeyInput("ArrowRight".into())),
            Some(R::ValueChanged(5.0))
        );
        assert_eq!(slider.handle(&ControlEvent::KeyInput("Tab".into())), None);
        assert_eq!(slider.handle(&ControlEvent::ValueChange(f64::NAN)), None);
    }
}
