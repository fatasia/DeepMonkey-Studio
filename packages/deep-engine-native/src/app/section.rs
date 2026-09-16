use super::NativeApp;
use winit::keyboard::KeyCode;

pub(super) fn key(app: &mut NativeApp, key: KeyCode) -> bool {
    let Some(plane) = changed_plane(app.state.view.clipping, key) else {
        return false;
    };
    if !app.content.active().material_bindings.is_empty() {
        if let Some(window) = &app.window {
            window.set_title("Deep Engine Native Viewer — section unavailable for authored ShaderPackage materials");
        }
        return true;
    }
    app.state.view.clipping = plane;
    app.state.selected = None;
    app.state.measurement.clear();
    if let Some(renderer) = &mut app.renderer {
        renderer.set_view(app.state.view);
    }
    if let Some(window) = &app.window {
        if plane == [0.0; 4] {
            window.set_title("Deep Engine Native Viewer — section off");
        } else {
            window.set_title(&format!(
            "Deep Engine Native Viewer — section [{:.2}, {:.2}, {:.2}] offset {:.2} (C toggles)",
            plane[0], plane[1], plane[2], plane[3]
        ));
        }
    }
    app.request_redraw();
    true
}

fn changed_plane(mut plane: [f32; 4], key: KeyCode) -> Option<[f32; 4]> {
    if key == KeyCode::KeyC {
        return Some(if plane[..3] == [0.; 3] {
            [1., 0., 0., 0.]
        } else {
            [0.; 4]
        });
    }
    if plane[..3] == [0.; 3] {
        return None;
    }
    match key {
        KeyCode::KeyX => plane = [1., 0., 0., plane[3]],
        KeyCode::KeyY => plane = [0., 1., 0., plane[3]],
        KeyCode::KeyZ => plane = [0., 0., 1., plane[3]],
        KeyCode::PageUp => plane[3] = (plane[3] + 0.1).min(1_000_000.),
        KeyCode::PageDown => plane[3] = (plane[3] - 0.1).max(-1_000_000.),
        KeyCode::Backspace => plane = [1., 0., 0., 0.],
        KeyCode::BracketLeft | KeyCode::BracketRight => {
            let angle: f32 = if key == KeyCode::BracketLeft {
                -0.1
            } else {
                0.1
            };
            let (sin, cos) = angle.sin_cos();
            // Fixed diagonal-axis Rodrigues rotation is continuous from all three axis presets.
            let unit = 1.0 / 3.0_f32.sqrt();
            let projection = (plane[0] + plane[1] + plane[2]) * unit;
            let cross = [
                plane[2] - plane[1],
                plane[0] - plane[2],
                plane[1] - plane[0],
            ];
            for axis in 0..3 {
                plane[axis] =
                    plane[axis] * cos + cross[axis] * unit * sin + unit * projection * (1.0 - cos);
            }
            let length = (plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]).sqrt();
            for value in &mut plane[..3] {
                *value /= length;
            }
        }
        _ => return None,
    }
    Some(plane)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn section_controls_normalize_bound_reset_and_disable() {
        let mut plane = changed_plane([0.; 4], KeyCode::KeyC).unwrap();
        for _ in 0..1000 {
            plane = changed_plane(plane, KeyCode::BracketRight).unwrap();
        }
        assert!(((0..3).map(|i| plane[i] * plane[i]).sum::<f32>() - 1.).abs() < 1e-5);
        plane[3] = 1_000_000.;
        assert_eq!(
            changed_plane(plane, KeyCode::PageUp).unwrap()[3],
            1_000_000.
        );
        assert_eq!(
            changed_plane(plane, KeyCode::Backspace),
            Some([1., 0., 0., 0.])
        );
        assert_eq!(changed_plane(plane, KeyCode::KeyC), Some([0.; 4]));
    }
}
