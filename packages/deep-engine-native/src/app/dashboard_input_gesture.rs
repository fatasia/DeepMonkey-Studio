use super::{NativeApp, apply};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(in crate::app) struct InputGesture {
    last_press: Option<(Instant, [f64; 2])>,
    origin: Option<[f64; 2]>,
    anchor: usize,
}
pub(in crate::app) fn press(app: &mut NativeApp, point: Option<[f64; 2]>) {
    apply(app, |candidate| candidate.clear_table_focus());
    let now = Instant::now();
    #[cfg(windows)]
    let timeout = Duration::from_millis(u64::from(unsafe {
        windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime()
    }));
    #[cfg(not(windows))]
    let timeout = Duration::from_millis(500);
    let word = point
        .zip(app.input_gesture.last_press)
        .is_some_and(|(p, (time, q))| {
            now.duration_since(time) <= timeout
                && (p[0] - q[0]).abs() <= 4.0
                && (p[1] - q[1]).abs() <= 4.0
        });
    let extend = app.input_modifiers.shift_key();
    apply(app, |candidate| {
        candidate.input_pointer_select(point, extend, word)
    });
    let focused = app
        .content
        .active()
        .dashboard
        .as_ref()
        .is_some_and(|r| r.input_focused());
    app.input_gesture.origin = point.filter(|_| focused);
    app.input_gesture.last_press = if word {
        None
    } else {
        point.filter(|_| focused).map(|p| (now, p))
    };
    if let Some(runtime) = app.content.active().dashboard.as_ref() {
        app.input_gesture.anchor = runtime.input_selection_anchor();
    }
    super::text_input::refresh(app);
}
pub(in crate::app) fn drag(app: &mut NativeApp, point: Option<[f64; 2]>) -> bool {
    let Some(origin) = app.input_gesture.origin else {
        return false;
    };
    let Some(point) = point else {
        return true;
    };
    if (point[0] - origin[0]).abs() + (point[1] - origin[1]).abs() < 3.0 {
        return true;
    }
    let anchor = app.input_gesture.anchor;
    apply(app, |candidate| {
        candidate.input_drag_selection(point[0], anchor)
    });
    super::text_input::refresh(app);
    true
}
pub(in crate::app) fn release(app: &mut NativeApp) {
    app.input_gesture.origin = None;
}
pub(in crate::app) fn blur(app: &mut NativeApp) {
    app.input_gesture = InputGesture::default();
}
