use super::{NativeApp, apply};
use winit::{
    dpi::{PhysicalPosition, PhysicalSize},
    event::{Ime, KeyEvent},
    keyboard::{KeyCode, PhysicalKey},
};

pub(in crate::app) fn ime(app: &mut NativeApp, event: Ime) -> bool {
    let Some(runtime) = app.content.active().dashboard.as_ref() else {
        return false;
    };
    if runtime.select_focused() {
        if let Ime::Commit(text) = event {
            apply(app, |candidate| candidate.select_text(&text));
        }
        refresh(app);
        return true;
    }
    if !runtime.input_focused() {
        return false;
    }
    apply(app, |candidate| candidate.input_ime(event));
    refresh(app);
    true
}
pub(in crate::app) fn select_text_key(app: &mut NativeApp, event: &KeyEvent) -> bool {
    let Some(runtime) = app.content.active().dashboard.as_ref() else {
        return false;
    };
    if !runtime.select_focused()
        || app.input_modifiers.control_key()
        || app.input_modifiers.super_key()
        || app.input_modifiers.alt_key()
    {
        return false;
    }
    let Some(text) = event.text.as_deref() else {
        return false;
    };
    if text.trim().is_empty() || text.chars().all(char::is_control) {
        return false;
    }
    apply(app, |candidate| candidate.select_text(text));
    refresh(app);
    true
}
pub(in crate::app) fn text_key(app: &mut NativeApp, event: &KeyEvent) -> bool {
    if event.physical_key == PhysicalKey::Code(KeyCode::Tab) {
        return false;
    }
    let Some(runtime) = app.content.active().dashboard.as_ref() else {
        return false;
    };
    if !runtime.has_text_inputs() {
        return false;
    }
    let PhysicalKey::Code(code) = event.physical_key else {
        return runtime.input_focused();
    };
    if !runtime.input_focused() && code != KeyCode::Tab {
        return false;
    }
    let key = format!("{code:?}");
    let control = app.input_modifiers.control_key() || app.input_modifiers.super_key();
    let shift = app.input_modifiers.shift_key();
    let clipboard_code = match (code, control, shift) {
        (KeyCode::Insert, true, _) => Some(KeyCode::KeyC),
        (KeyCode::Insert, false, true) => Some(KeyCode::KeyV),
        (KeyCode::Delete, false, true) => Some(KeyCode::KeyX),
        (KeyCode::KeyC | KeyCode::KeyX | KeyCode::KeyV, true, _) => Some(code),
        _ => None,
    };
    if clipboard_code.is_some_and(|code| super::clipboard_input::key(app, code)) {
        return true;
    }
    apply(app, |candidate| {
        candidate.input_key(&key, event.text.as_deref(), control, shift)
    });
    refresh(app);
    true
}
pub(in crate::app) fn refresh(app: &NativeApp) {
    let Some(window) = &app.window else {
        return;
    };
    let Some(runtime) = app.content.active().dashboard.as_ref() else {
        return;
    };
    let focused = runtime.input_focused() || runtime.select_focused();
    window.set_ime_allowed(focused);
    if !focused {
        return;
    }
    let caret = if runtime.input_focused() {
        runtime.input_caret_rect().ok().flatten()
    } else {
        runtime.select_ime_rect()
    };
    let Some(caret) = caret else {
        return;
    };
    let list = runtime.content().display_list();
    let size = window.inner_size();
    let mapping = deep_engine_native::deep2d::LetterboxMapping::new(
        [list.logical_width, list.logical_height],
        [size.width.into(), size.height.into()],
    );
    let point = mapping.logical_to_physical([caret[0], caret[1]]);
    window.set_ime_cursor_area(
        PhysicalPosition::new(point[0], point[1]),
        PhysicalSize::new(
            (caret[2] * mapping.scale).ceil() as u32,
            (caret[3] * mapping.scale).ceil() as u32,
        ),
    );
}
