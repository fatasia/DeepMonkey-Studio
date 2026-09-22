use super::NativeApp;
use winit::keyboard::KeyCode;

pub(super) fn key(app: &mut NativeApp, key: KeyCode) -> bool {
    let Some(index) = view_index(key) else {
        return false;
    };
    let Some((id, name, view)) = app.content.active().camera_view(index) else {
        return false;
    };
    let id = id.to_owned();
    let name = name.to_owned();
    app.state
        .set_camera(view, app.content.active().camera_controls());
    if let Some(renderer) = app.renderer.as_mut() {
        renderer.set_view(app.state.view);
    }
    if let Some(window) = &app.window {
        crate::window_chrome::set_title(
            window,
            &format!("Deep Engine Native Viewer — camera: {name} ({id})"),
        );
    }
    app.request_redraw();
    true
}

fn view_index(key: KeyCode) -> Option<usize> {
    Some(match key {
        KeyCode::Digit1 | KeyCode::Numpad1 => 0,
        KeyCode::Digit2 | KeyCode::Numpad2 => 1,
        KeyCode::Digit3 | KeyCode::Numpad3 => 2,
        KeyCode::Digit4 | KeyCode::Numpad4 => 3,
        KeyCode::Digit5 | KeyCode::Numpad5 => 4,
        KeyCode::Digit6 | KeyCode::Numpad6 => 5,
        KeyCode::Digit7 | KeyCode::Numpad7 => 6,
        KeyCode::Digit8 | KeyCode::Numpad8 => 7,
        KeyCode::Digit9 | KeyCode::Numpad9 => 8,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_top_row_and_numpad_without_claiming_other_keys() {
        assert_eq!(view_index(KeyCode::Digit1), Some(0));
        assert_eq!(view_index(KeyCode::Numpad9), Some(8));
        assert_eq!(view_index(KeyCode::Digit0), None);
        assert_eq!(view_index(KeyCode::KeyA), None);
    }
}
