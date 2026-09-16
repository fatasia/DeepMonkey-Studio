//! P1-16 chart a11y contract (zoom + screen-reader semantics + mouse
//! parity): zoom shortcuts reproduce the wheel math with clamps, keyboard
//! toggles are byte-equal to mouse legend clicks on the shared
//! InteractionState, and the legend projects into a labeled semantics tree.
//! Focus state machine coverage lives in native_ui_chart_keyboard.rs.
//! Pure CPU; no window required.

use deep_engine_native::chart::interaction_contract::LegendPosition;
use deep_engine_native::chart::legend::{LegendAction, LegendFrame};
use deep_engine_native::chart::{ChartAction, ChartRuntime, parse_chart_ir};
use deep_engine_native::native_ui::chart_a11y::{
    ChartKeyInput, ChartKeyResponse, ChartKeyboardState, LegendCommand, LegendItemSnapshot,
    LegendSnapshot, legend_item_id, legend_semantics_tree, zoom_step_window,
};
use deep_engine_native::native_ui::retained_ui::RetainedUiRole;

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

/// Repeats a zoom shortcut, feeding each result forward like the app wiring.
fn zoom_repeat(
    kb: &mut ChartKeyboardState,
    snap: &mut LegendSnapshot,
    input: ChartKeyInput,
    times: usize,
) -> (f64, f64) {
    let mut window = snap.zoom_window;
    for _ in 0..times {
        if let ChartKeyResponse::Zoom { start, end } = kb.handle(snap, input) {
            window = (start, end);
            snap.zoom_window = window;
        }
    }
    window
}

#[test]
fn zoom_shortcuts_reproduce_wheel_math_with_clamps() {
    // Same float ops as the wheel handler: compare with wheel-grade epsilon.
    let (start, end) = zoom_step_window(0.0, 1.0, true).unwrap();
    assert!((start - 0.1).abs() < 1e-12 && (end - 0.9).abs() < 1e-12);
    let (start, end) = zoom_step_window(0.1, 0.9, false).unwrap();
    assert!(start.abs() < 1e-12 && (end - 1.0).abs() < 1e-12);
    assert_eq!(zoom_step_window(f64::NAN, 1.0, true), None);
    assert_eq!(zoom_step_window(0.5, 0.5, true), None);
    let mut snap = snapshot(vec![]);
    let mut kb = ChartKeyboardState::new();
    match kb.handle(&snap, ChartKeyInput::ZoomIn) {
        ChartKeyResponse::Zoom { start, .. } => {
            assert!(
                (start - 0.1).abs() < 1e-12,
                "zoom works without legend focus"
            );
        }
        other => panic!("expected zoom, got {other:?}"),
    }
    let window = zoom_repeat(&mut kb, &mut snap, ChartKeyInput::ZoomIn, 64);
    assert!(
        (window.1 - window.0 - 0.01).abs() < 1e-12,
        "span floors at 0.01"
    );
    let window = zoom_repeat(&mut kb, &mut snap, ChartKeyInput::ZoomOut, 128);
    assert_eq!(window, (0.0, 1.0), "zoom out caps at the full window");
}

#[test]
fn keyboard_toggle_is_byte_equal_to_the_mouse_path_on_shared_state() {
    // Two identical charts: one driven exactly like a mouse legend click
    // (the LegendAction resolved by hit), one by the keyboard Activate
    // command. Both feed the SAME ChartAction into the SAME InteractionState,
    // so a keyboard toggle can never diverge from (or corrupt) mouse state.
    let hover = ChartAction::Hover {
        series_id: "series-1".into(),
        data_index: 0,
        x_label: "周一".into(),
        value: "12".into(),
    };
    let mut mouse = chart(4);
    let mut keyboard = chart(4);
    mouse.dispatch(hover.clone()).unwrap();
    keyboard.dispatch(hover).unwrap();
    assert!(mouse.state().tooltip.is_some());
    let frame = LegendFrame::prepare(&mouse, 0).unwrap();
    let hit = frame
        .items
        .iter()
        .find(|item| item.action == LegendAction::Toggle("series-0".into()))
        .map(|item| frame.hit([item.rect[0] + item.rect[2] / 2.0, item.rect[1] + 1.0]))
        .unwrap();
    let LegendAction::Toggle(series_id) = hit.unwrap().clone() else {
        panic!()
    };
    mouse
        .dispatch(ChartAction::ToggleLegend { series_id })
        .unwrap();
    let snap = snapshot_of(&frame);
    let mut kb = ChartKeyboardState::new();
    focus_to(&mut kb, &snap, 0); // first item on page 0 is series-0's toggle
    let ChartKeyResponse::Activate { command, .. } = kb.handle(&snap, ChartKeyInput::Enter) else {
        panic!("keyboard enter activates the focused series toggle");
    };
    let LegendCommand::Toggle(series_id) = command else {
        panic!()
    };
    keyboard
        .dispatch(ChartAction::ToggleLegend { series_id })
        .unwrap();
    // Byte-equal interaction state (the runtime clears hover on legend
    // geometry rebuilds; the keyboard receives exactly that shared behavior).
    assert_eq!(keyboard.state(), mouse.state());
    assert_eq!(mouse.state().hidden_series, vec!["series-0".to_string()]);
}

#[test]
fn semantics_tree_lists_legend_items_in_walk_order() {
    let snap = snapshot(vec![
        item(
            "泵站 0",
            false,
            [0.0; 4],
            LegendCommand::Toggle("s0".into()),
        ),
        item("泵站 1", true, [1.0; 4], LegendCommand::Toggle("s1".into())),
    ]);
    let tree = legend_semantics_tree(&snap).unwrap();
    let root = tree.node("chart-legend").unwrap();
    assert_eq!(root.role, RetainedUiRole::Region);
    assert_eq!(
        root.children,
        snap.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>()
    );
    assert_eq!(
        tree.walk_ids(),
        vec![
            "chart-legend".to_string(),
            snap.items[0].id.clone(),
            snap.items[1].id.clone()
        ]
    );
    let button = tree.node(&snap.items[0].id).unwrap();
    assert_eq!(button.role, RetainedUiRole::Button);
    assert!(button.name.as_deref().unwrap().contains("泵站 0"));
    assert_eq!(button.value.as_deref(), Some("visible"));
    assert_eq!(
        tree.node(&snap.items[1].id).unwrap().value.as_deref(),
        Some("hidden")
    );
}
