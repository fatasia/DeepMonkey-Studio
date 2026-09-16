//! P1-16 keyboard a11y contract: keyboard events drive state assertions —
//! focus moves, Enter/Space activating the SAME LegendAction the pointer hit
//! yields, and Esc release. Pure CPU; no window required.
//!
//! Zoom math, semantics-tree labels and mouse-parity live in
//! native_ui_chart_a11y_semantics.rs.

use deep_engine_native::chart::interaction_contract::LegendPosition;
use deep_engine_native::chart::legend::{LegendAction, LegendFrame};
use deep_engine_native::chart::{ChartRuntime, parse_chart_ir};
use deep_engine_native::native_ui::accessibility::{UiAAction, map_action_to_event};
use deep_engine_native::native_ui::chart_a11y::{
    ChartKeyInput, ChartKeyResponse, ChartKeyboardState, LegendCommand, LegendItemSnapshot,
    LegendSnapshot, legend_item_id,
};
use deep_engine_native::native_ui::control_render::focus_ring_rect;

const FIXTURE: &[u8] = include_bytes!("../../deep-engine/fixtures/chart-ir-v1.json");

fn item(label: &str, hidden: bool, rect: [f64; 4], command: LegendCommand) -> LegendItemSnapshot {
    LegendItemSnapshot {
        id: legend_item_id(0, &command),
        label: label.into(),
        hidden,
        rect,
        command,
    }
}

fn snapshot(items: Vec<LegendItemSnapshot>) -> LegendSnapshot {
    LegendSnapshot {
        page: 0,
        pages: 1,
        zoom_window: (0.0, 1.0),
        items,
    }
}

/// Maps a real LegendFrame into the keyboard snapshot the app wiring builds.
fn snapshot_of(frame: &LegendFrame) -> LegendSnapshot {
    let command = |action: &LegendAction| match action {
        LegendAction::Toggle(id) => LegendCommand::Toggle(id.clone()),
        LegendAction::Page(page) => LegendCommand::Page(*page),
    };
    LegendSnapshot {
        page: frame.page,
        pages: frame.pages,
        zoom_window: (0.0, 1.0),
        items: frame
            .items
            .iter()
            .map(|item| {
                let command = command(&item.action);
                LegendItemSnapshot {
                    id: legend_item_id(frame.page, &command),
                    label: item.label.clone(),
                    hidden: item.hidden,
                    rect: item.rect,
                    command,
                }
            })
            .collect(),
    }
}

fn chart(series_count: usize) -> ChartRuntime {
    let mut source = parse_chart_ir(FIXTURE).unwrap();
    source.actions.clear();
    source.data_zoom.clear();
    source.tooltip.enabled = true;
    source.legend.visible = true;
    source.legend.position = LegendPosition::Top;
    let series = source.series[0].clone();
    source.series = (0..series_count)
        .map(|index| {
            let mut s = series.clone();
            s.id = format!("series-{index}");
            s.label = format!("泵站 {index}");
            s
        })
        .collect();
    ChartRuntime::new(source, 640.0, 360.0).unwrap()
}

/// Walks keyboard focus to `index` from any state (re-focus if needed).
fn focus_to(kb: &mut ChartKeyboardState, snap: &LegendSnapshot, index: usize) {
    if kb.focused_item().is_some() {
        kb.handle(snap, ChartKeyInput::Escape); // Tab would cycle out instead
    }
    kb.handle(snap, ChartKeyInput::Tab);
    for _ in 0..index {
        kb.handle(snap, ChartKeyInput::Next);
    }
    assert_eq!(kb.focused_item(), Some(index));
}

#[test]
fn tab_focuses_first_item_with_retained_ui_ring_and_a11y_event() {
    let snap = snapshot(vec![
        item(
            "泵站 0",
            false,
            [10.0, 10.0, 50.0, 20.0],
            LegendCommand::Toggle("s0".into()),
        ),
        item(
            "泵站 1",
            true,
            [70.0, 10.0, 50.0, 20.0],
            LegendCommand::Toggle("s1".into()),
        ),
    ]);
    let mut kb = ChartKeyboardState::new();
    assert_eq!(
        kb.handle(&snap, ChartKeyInput::Enter),
        ChartKeyResponse::NotHandled
    );
    let ChartKeyResponse::FocusChanged {
        item,
        ring,
        announcement,
        event,
    } = kb.handle(&snap, ChartKeyInput::Tab)
    else {
        panic!("expected focus change");
    };
    assert_eq!(item, 0);
    assert_eq!(ring, focus_ring_rect([10.0, 10.0, 50.0, 20.0]));
    assert!(announcement.contains("泵站 0") && announcement.contains("visible"));
    assert_eq!(
        event,
        map_action_to_event(&UiAAction::Focus, &snap.items[0].id)
    );
    assert_eq!(kb.focused_item(), Some(0));
    // Ring geometry is the control-paint focus ring, anchored at the item.
    assert_eq!(
        focus_ring_rect([10.0, 20.0, 50.0, 20.0]),
        [7.0, 17.0, 56.0, 26.0]
    );
}

#[test]
fn arrows_move_focus_and_clamp_at_both_ends() {
    let snap = snapshot(vec![
        item("s0", false, [0.0; 4], LegendCommand::Toggle("s0".into())),
        item("s1", false, [1.0; 4], LegendCommand::Toggle("s1".into())),
        item("s2", false, [2.0; 4], LegendCommand::Toggle("s2".into())),
    ]);
    let mut kb = ChartKeyboardState::new();
    kb.handle(&snap, ChartKeyInput::Tab);
    kb.handle(&snap, ChartKeyInput::Prev);
    assert_eq!(kb.focused_item(), Some(0), "clamped at first item");
    kb.handle(&snap, ChartKeyInput::Next);
    kb.handle(&snap, ChartKeyInput::Next);
    let ChartKeyResponse::FocusChanged { ring, .. } = kb.handle(&snap, ChartKeyInput::Next) else {
        panic!("expected focus change");
    };
    assert_eq!(kb.focused_item(), Some(2), "clamped at last item");
    assert_eq!(ring, focus_ring_rect([2.0; 4]));
    kb.handle(&snap, ChartKeyInput::Prev);
    assert_eq!(kb.focused_item(), Some(1));
}

#[test]
fn esc_releases_focus_then_falls_through_to_existing_bindings() {
    let snap = snapshot(vec![item(
        "s0",
        false,
        [0.0; 4],
        LegendCommand::Toggle("s0".into()),
    )]);
    let mut kb = ChartKeyboardState::new();
    assert_eq!(
        kb.handle(&snap, ChartKeyInput::Escape),
        ChartKeyResponse::NotHandled
    );
    kb.handle(&snap, ChartKeyInput::Tab);
    assert_eq!(
        kb.handle(&snap, ChartKeyInput::Escape),
        ChartKeyResponse::FocusReleased
    );
    assert_eq!(kb.focused_item(), None);
    assert_eq!(
        kb.handle(&snap, ChartKeyInput::Escape),
        ChartKeyResponse::NotHandled
    );
    assert_eq!(
        kb.handle(&snap, ChartKeyInput::Enter),
        ChartKeyResponse::NotHandled
    );
    // Tab cycles out when already focused (single focusable region).
    kb.handle(&snap, ChartKeyInput::Tab);
    assert_eq!(
        kb.handle(&snap, ChartKeyInput::Tab),
        ChartKeyResponse::FocusReleased
    );
}

#[test]
fn enter_yields_exactly_the_pointer_action_for_toggle_and_page_items() {
    let frame = LegendFrame::prepare(&chart(128), 0).unwrap();
    assert!(frame.pages > 1, "fixture must page to expose a page item");
    let snap = snapshot_of(&frame);
    let toggle_index = snap
        .items
        .iter()
        .position(|item| matches!(item.command, LegendCommand::Toggle(_)))
        .unwrap();
    let page_index = snap
        .items
        .iter()
        .position(|item| item.command == LegendCommand::Page(1))
        .expect("forward page arrow exists on page 0");
    assert_eq!(
        legend_item_id(0, &LegendCommand::Page(1)),
        "legend:0:page:1"
    );
    let mut kb = ChartKeyboardState::new();
    // Keyboard Enter on the toggle item == the action a click at the same
    // rect resolves.
    focus_to(&mut kb, &snap, toggle_index);
    let rect = snap.items[toggle_index].rect;
    assert_eq!(
        kb.handle(&snap, ChartKeyInput::Enter),
        ChartKeyResponse::Activate {
            command: LegendCommand::Toggle("series-0".into()),
            announcement: snap.items[toggle_index].label.clone() + ", visible, Enter hides",
            event: map_action_to_event(&UiAAction::Invoke, &snap.items[toggle_index].id),
        }
    );
    assert_eq!(
        frame.hit([rect[0] + 1.0, rect[1] + 1.0]),
        Some(&LegendAction::Toggle("series-0".into()))
    );
    // Keyboard Space on the page item == the page command a click resolves
    // (Space is an Enter synonym).
    focus_to(&mut kb, &snap, page_index);
    let rect = snap.items[page_index].rect;
    assert_eq!(
        kb.handle(&snap, ChartKeyInput::Space),
        ChartKeyResponse::Activate {
            command: LegendCommand::Page(1),
            announcement: "legend page 2 of 26".into(),
            event: map_action_to_event(&UiAAction::Invoke, &snap.items[page_index].id),
        }
    );
    assert_eq!(
        frame.hit([rect[0] + 1.0, rect[1] + 1.0]),
        Some(&LegendAction::Page(1))
    );
}

#[test]
fn focus_clamps_when_the_page_shrinks_under_it() {
    let wide = snapshot(vec![
        item("s0", false, [0.0; 4], LegendCommand::Toggle("s0".into())),
        item("s1", false, [1.0; 4], LegendCommand::Toggle("s1".into())),
    ]);
    let narrow = snapshot(vec![item(
        "s0",
        false,
        [0.0; 4],
        LegendCommand::Toggle("s0".into()),
    )]);
    let mut kb = ChartKeyboardState::new();
    kb.handle(&wide, ChartKeyInput::Tab);
    kb.handle(&wide, ChartKeyInput::Next);
    assert_eq!(kb.focused_item(), Some(1));
    assert_eq!(
        kb.handle(&narrow, ChartKeyInput::Enter),
        ChartKeyResponse::Activate {
            command: LegendCommand::Toggle("s0".into()),
            announcement: "s0, visible, Enter hides".into(),
            event: map_action_to_event(&UiAAction::Invoke, "legend:0:toggle:s0"),
        },
        "stale focus clamps to the surviving item, never a ghost"
    );
}
