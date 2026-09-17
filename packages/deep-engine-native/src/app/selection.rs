use super::NativeApp;
use crate::player_picking;

pub(super) fn click(app: &mut NativeApp) {
    if app.state.annotations.draft.is_some() {
        return;
    }
    let Some(pixel) = app.state.cursor else {
        return;
    };
    let Some(window) = &app.window else { return };
    let size = window.inner_size();
    let hit = player_picking::pick_world(
        app.content.active(),
        app.state.view,
        [size.width, size.height],
        pixel,
    );
    app.state.selected = hit.as_ref().map(|hit| hit.local.id.clone());
    app.state.selected_point = hit.as_ref().map(|hit| hit.local.point);
    if let Some(hit) = hit {
        if app.state.measurement.enabled {
            app.state.measurement.hit(hit.world_point);
            let title = if let Some(distance) = app.state.measurement.distance {
                println!("native measurement: distance={distance:.6} units=scene");
                format!("Deep Engine Native Viewer — distance: {distance:.3} scene units")
            } else {
                "Deep Engine Native Viewer — measurement: select second point".into()
            };
            crate::window_chrome::set_title(window, &title);
            return;
        }
        let hit = hit.local;
        player_picking::focus(&mut app.state.view, &hit, [size.width, size.height]);
        if let Some(renderer) = app.renderer.as_mut() {
            renderer.set_view(app.state.view);
        }
        crate::window_chrome::set_title(
            window,
            &format!("Deep Engine Native Viewer — selected: {}", hit.id),
        );
        println!(
            "native selection: id={} point={:?} target={:?}",
            hit.id, hit.point, app.state.view.target
        );
    } else {
        app.state.measurement.clear();
        crate::window_chrome::set_title(window, "Deep Engine Native Viewer — no selection");
    }
    app.request_redraw();
}

pub(super) fn clear(app: &mut NativeApp) {
    clear_state(&mut app.state);
    if let Some(window) = &app.window {
        crate::window_chrome::set_title(
            window,
            "Deep Engine Native Viewer — select an object to focus",
        );
    }
}

fn clear_state(state: &mut crate::player_state::PlayerState) {
    state.selected = None;
    state.selected_point = None;
    state.cursor = None;
    state.measurement.clear();
}

fn reset_state(
    state: &mut crate::player_state::PlayerState,
    content: &crate::player_content::PlayerContent,
) {
    clear_state(state);
    state.view = content.initial_view();
}

pub(super) fn reset_view(app: &mut NativeApp) {
    clear(app);
    reset_state(&mut app.state, app.content.active());
    if let Some(renderer) = app.renderer.as_mut() {
        renderer.set_view(app.state.view);
    }
    app.request_redraw();
}

pub(super) fn toggle_measurement(app: &mut NativeApp) {
    app.state.measurement.toggle();
    if let Some(window) = &app.window {
        crate::window_chrome::set_title(
            window,
            if app.state.measurement.enabled {
                "Deep Engine Native Viewer — measurement: select first point (M to exit)"
            } else {
                "Deep Engine Native Viewer — select an object to focus"
            },
        );
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reset_restores_authored_local_camera_and_clears_world_measurement() {
        let content = crate::player_content::PlayerContent::from_package(
            deep_engine_native::runtime_package::parse_and_validate_runtime_package(
                include_bytes!("../../tests/fixtures/runtime-package-coordinate-origin-b.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let mut state = crate::player_state::PlayerState {
            selected: Some("box".into()),
            selected_point: Some([1.0; 3]),
            cursor: Some([12.0; 2]),
            ..Default::default()
        };
        state.measurement.toggle();
        state.measurement.hit([1e9; 3]);
        state.measurement.hit([1e9 + 1.0; 3]);
        super::reset_state(&mut state, &content);
        assert_eq!(state.view, content.initial_view());
        assert_eq!(state.view.target, [-1000.0, 0.0, 0.0]);
        assert!(
            state.selected.is_none() && state.selected_point.is_none() && state.cursor.is_none()
        );
        assert!(state.measurement.anchor.is_none() && state.measurement.distance.is_none());
    }
}
