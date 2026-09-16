//! U04 paint-contract golden: control state must be visible in geometry —
//! focused controls carry a focus ring (extra stroke), disabled controls
//! render at reduced opacity, toggle/slider knobs move with value — and
//! every generated display list passes the production validator.

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, validate_display_list,
};
use deep_engine_native::native_ui::{
    ControlCanvas, ControlPalette, DISABLED_OPACITY, PaintContext, render_button, render_checkbox,
    render_select, render_slider, render_toggle,
};

const RECT: [f64; 4] = [20.0, 20.0, 120.0, 36.0];

fn count_focus_rings(list: &Deep2dDisplayList) -> usize {
    list.commands
        .iter()
        .filter(|command| match command {
            Deep2dCommand::Path(path) => path.id.ends_with(":focus"),
            _ => false,
        })
        .count()
}

fn opacity_of_first_fill(list: &Deep2dDisplayList) -> f64 {
    for command in &list.commands {
        if let Deep2dCommand::Path(path) = command {
            return path.opacity.unwrap_or(1.0);
        }
    }
    1.0
}

fn assert_valid(list: &Deep2dDisplayList, context: &str) {
    let validation = validate_display_list(list);
    assert!(validation.valid, "{context}: {:?}", validation.issues);
}

#[test]
fn button_states_differ_in_geometry_and_stay_valid() {
    let palette = ControlPalette::dark();
    let normal_ctx = PaintContext {
        palette: &palette,
        disabled: false,
        focused: false,
    };
    let focused_ctx = PaintContext {
        palette: &palette,
        disabled: false,
        focused: true,
    };
    let disabled_ctx = PaintContext {
        palette: &palette,
        disabled: true,
        focused: false,
    };
    let mut normal = ControlCanvas::new();
    render_button(&mut normal, "btn", RECT, false, &normal_ctx);
    let mut focused = ControlCanvas::new();
    render_button(&mut focused, "btn", RECT, false, &focused_ctx);
    let mut disabled = ControlCanvas::new();
    render_button(&mut disabled, "btn", RECT, false, &disabled_ctx);

    let normal = normal.into_display_list(200.0, 100.0);
    let focused = focused.into_display_list(200.0, 100.0);
    let disabled = disabled.into_display_list(200.0, 100.0);
    assert_valid(&normal, "button normal");
    assert_valid(&focused, "button focused");
    assert_valid(&disabled, "button disabled");

    assert_eq!(count_focus_rings(&normal), 0);
    assert_eq!(count_focus_rings(&focused), 1, "focus must draw a ring");
    assert!(
        (opacity_of_first_fill(&disabled) - DISABLED_OPACITY).abs() < 1e-9,
        "disabled must render at the contract opacity"
    );
    assert!((opacity_of_first_fill(&normal) - 1.0).abs() < 1e-9);
}

#[test]
fn toggle_knob_flips_side_when_checked() {
    let palette = ControlPalette::dark();
    let ctx = PaintContext {
        palette: &palette,
        disabled: false,
        focused: false,
    };
    let mut off = ControlCanvas::new();
    render_toggle(&mut off, "tg", RECT, false, &ctx);
    let mut on = ControlCanvas::new();
    render_toggle(&mut on, "tg", RECT, true, &ctx);
    let off = off.into_display_list(200.0, 100.0);
    let on = on.into_display_list(200.0, 100.0);
    assert_valid(&off, "toggle off");
    assert_valid(&on, "toggle on");

    let knob_x = |list: &Deep2dDisplayList| {
        // Knob geometry lives in the path verbs (identity transform); find
        // the resource id from the command, then read its first vertex.
        let knob_path_id = list.commands.iter().find_map(|command| match command {
            Deep2dCommand::Path(path) if path.id.ends_with(":knob") => Some(path.path_id.clone()),
            _ => None,
        })?;
        list.resources.iter().find_map(|resource| match resource {
            Deep2dResource::Path(path) if path.id == knob_path_id => {
                path.verbs.first().map(|verb| match verb {
                    Deep2dPathVerb::Move { x, .. } => *x,
                    _ => 0.0,
                })
            }
            _ => None,
        })
    };
    let off_x = knob_x(&off).expect("knob present");
    let on_x = knob_x(&on).expect("knob present");
    assert!(
        on_x > off_x,
        "checked knob must sit to the right: {off_x} vs {on_x}"
    );
}

#[test]
fn checkbox_checkmark_only_when_checked() {
    let palette = ControlPalette::dark();
    let normal_ctx = PaintContext {
        palette: &palette,
        disabled: false,
        focused: false,
    };
    let focused_ctx = PaintContext {
        palette: &palette,
        disabled: false,
        focused: true,
    };
    let mut unchecked = ControlCanvas::new();
    render_checkbox(&mut unchecked, "cb", RECT, false, &normal_ctx);
    let mut checked = ControlCanvas::new();
    render_checkbox(&mut checked, "cb", RECT, true, &focused_ctx);
    let unchecked = unchecked.into_display_list(200.0, 100.0);
    let checked = checked.into_display_list(200.0, 100.0);
    assert_valid(&unchecked, "checkbox unchecked");
    assert_valid(&checked, "checkbox checked");
    let has_check = |list: &Deep2dDisplayList| {
        list.commands.iter().any(
            |command| matches!(command, Deep2dCommand::Path(path) if path.id.ends_with(":check")),
        )
    };
    assert!(!has_check(&unchecked));
    assert!(has_check(&checked));
    assert_eq!(count_focus_rings(&checked), 1);
}

#[test]
fn select_open_state_expands_panel_with_highlight() {
    let palette = ControlPalette::dark();
    let ctx = PaintContext {
        palette: &palette,
        disabled: false,
        focused: false,
    };
    let mut closed = ControlCanvas::new();
    render_select(
        &mut closed,
        &deep_engine_native::native_ui::control_render::SelectPaint {
            id: "sel",
            rect: RECT,
            open: false,
            highlighted_index: 0,
            row_height: 20.0,
            ctx,
        },
    );
    let mut open = ControlCanvas::new();
    render_select(
        &mut open,
        &deep_engine_native::native_ui::control_render::SelectPaint {
            id: "sel",
            rect: RECT,
            open: true,
            highlighted_index: 1,
            row_height: 20.0,
            ctx,
        },
    );
    let closed = closed.into_display_list(200.0, 200.0);
    let open = open.into_display_list(200.0, 200.0);
    assert_valid(&closed, "select closed");
    assert_valid(&open, "select open");
    assert!(
        open.commands.len() > closed.commands.len() + 1,
        "open adds panel + highlight geometry"
    );
}

#[test]
fn slider_knob_tracks_value_across_range() {
    let palette = ControlPalette::dark();
    let knob_x = |value: f64| {
        let mut canvas = ControlCanvas::new();
        render_slider(
            &mut canvas,
            &deep_engine_native::native_ui::control_render::SliderPaint {
                id: "sl",
                rect: RECT,
                min: 0.0,
                max: 100.0,
                value,
                ctx: PaintContext {
                    palette: &palette,
                    disabled: false,
                    focused: value == 100.0,
                },
            },
        );
        let list = canvas.into_display_list(200.0, 100.0);
        assert_valid(&list, "slider");
        let knob_path_id = list
            .commands
            .iter()
            .find_map(|command| match command {
                Deep2dCommand::Path(path) if path.id.ends_with(":knob") => {
                    Some(path.path_id.clone())
                }
                _ => None,
            })
            .expect("knob command");
        let resource = list
            .resources
            .iter()
            .find_map(|resource| match resource {
                Deep2dResource::Path(path) if path.id == knob_path_id => Some(path),
                _ => None,
            })
            .expect("knob resource");
        let first = resource.verbs.first().expect("knob verbs");
        match first {
            Deep2dPathVerb::Move { x, .. } => x + 6.0,
            _ => 0.0,
        }
    };
    let at_min = knob_x(0.0);
    let at_mid = knob_x(50.0);
    let at_max = knob_x(100.0);
    assert!(at_min < at_mid && at_mid < at_max, "knob must track value");
    assert!(
        (at_max - at_min - RECT[2]).abs() < 1e-6,
        "knob spans the full track"
    );
}

#[test]
fn light_palette_produces_valid_alternative_theme() {
    let palette = ControlPalette::light();
    let mut canvas = ControlCanvas::new();
    let focused_ctx = PaintContext {
        palette: &palette,
        disabled: false,
        focused: true,
    };
    let ctx = PaintContext {
        palette: &palette,
        disabled: false,
        focused: false,
    };
    render_button(&mut canvas, "b", RECT, false, &focused_ctx);
    render_toggle(&mut canvas, "t", [20.0, 70.0, 48.0, 24.0], true, &ctx);
    let list = canvas.into_display_list(200.0, 120.0);
    assert_valid(&list, "light theme controls");
}
