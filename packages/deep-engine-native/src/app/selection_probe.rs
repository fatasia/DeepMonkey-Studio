//! Routes synthetic input through the real window handler between submitted GPU frames.
use super::NativeApp;
use crate::player_picking;
use winit::{
    event::{DeviceId, ElementState, MouseButton, WindowEvent},
    event_loop::ActiveEventLoop,
};

pub(super) fn advance(app: &mut NativeApp, event_loop: &ActiveEventLoop) -> Result<bool, String> {
    let window = app.window.as_ref().ok_or("selection probe has no window")?;
    let size = window.inner_size();
    let viewport = [size.width, size.height];
    if app.selection_probe == Some(0) {
        let mut candidate = None;
        'scan: for y in 1..size.height {
            for x in 1..size.width {
                let pixel = [x as f64, y as f64];
                if let Some(hit) = player_picking::pick(
                    app.content.active().packet(),
                    app.state.view,
                    viewport,
                    pixel,
                ) {
                    candidate = Some((pixel, hit));
                    break 'scan;
                }
            }
        }
        let (pixel, hit) = candidate.ok_or("selection probe fixture has no visible triangle")?;
        dispatch(app, event_loop, pixel);
        if app.state.selected.as_deref() != Some(&hit.id) || app.state.view.target != hit.center {
            return Err("window click did not select and focus the authored identity".into());
        }
        app.selection_probe = Some(1);
        return Ok(false);
    }
    let selected = app
        .state
        .selected
        .clone()
        .ok_or("selection lost across GPU frame")?;
    let centered = player_picking::pick(
        app.content.active().packet(),
        app.state.view,
        viewport,
        [size.width as f64 / 2.0, size.height as f64 / 2.0],
    );
    if centered.as_ref().map(|hit| &hit.id) != Some(&selected) {
        return Err("focused object is not under the viewport center".into());
    }
    let focused_view = app.state.view;
    let note_point = centered.as_ref().ok_or("annotation anchor missing")?.point;
    annotation_probe(app, event_loop, &selected, note_point)?;
    let first_world = app
        .content
        .active()
        .local_to_world(note_point.map(f64::from))?;
    let second_world = player_picking::pick_world(
        app.content.active(),
        focused_view,
        viewport,
        [size.width as f64 / 2.0 + 1.0, size.height as f64 / 2.0],
    )
    .ok_or("second world measurement point missing")?
    .world_point;
    super::selection::toggle_measurement(app);
    dispatch(
        app,
        event_loop,
        [size.width as f64 / 2.0, size.height as f64 / 2.0],
    );
    if app.state.measurement.anchor != Some(first_world) {
        return Err("measurement anchor is not the content frame's f64 world point".into());
    }
    dispatch(
        app,
        event_loop,
        [size.width as f64 / 2.0 + 1.0, size.height as f64 / 2.0],
    );
    if app
        .state
        .measurement
        .distance
        .is_none_or(|distance| distance <= 0.0 || !distance.is_finite())
        || app.state.view != focused_view
    {
        return Err("measurement clicks did not produce a distance with a stable camera".into());
    }
    let expected_distance = (0..3)
        .map(|axis| (second_world[axis] - first_world[axis]).powi(2))
        .sum::<f64>()
        .sqrt();
    let actual_distance = app.state.measurement.distance.unwrap();
    if (actual_distance - expected_distance).abs() > 0.004 {
        return Err("world measurement exceeds fixed 0.004 scene-unit error budget".into());
    }
    println!(
        "native selection world probe: first={first_world:?} second={second_world:?} actual_distance={actual_distance:?} expected_distance={expected_distance:?}"
    );
    dispatch(app, event_loop, [0.0, 0.0]);
    if app.state.selected.is_some() {
        return Err("blank click did not clear selection".into());
    }
    app.state.selected = Some(selected.clone());
    super::selection::clear(app);
    if app.state.selected.is_some()
        || app.state.cursor.is_some()
        || app.state.measurement.anchor.is_some()
    {
        return Err("package publication did not clear selection input".into());
    }
    super::selection::reset_view(app);
    if app.state.view != app.content.active().initial_view()
        || app.state.selected_point.is_some()
        || app.state.measurement.distance.is_some()
    {
        return Err(
            "reset did not restore authored local camera and clear world tool state".into(),
        );
    }
    println!(
        "native selection GPU probe OK: id={selected} events=cursor-left-click focus=submitted blank=cleared package=cleared measurement=two-world-points reset=authored-camera annotations=persisted ime=preedit-commit-disable draft=protected"
    );
    app.selection_probe = None;
    Ok(true)
}

fn annotation_probe(
    app: &mut NativeApp,
    event_loop: &ActiveEventLoop,
    id: &str,
    point: [f32; 3],
) -> Result<(), String> {
    use winit::event::Ime;
    use winit::keyboard::KeyCode;
    app.state.selected_point = Some(point);
    super::annotations::key(app, KeyCode::KeyA, None);
    let window_id = app.window.as_ref().expect("probe window exists").id();
    for event in [Ime::Enabled, Ime::Preedit("jian cha".into(), Some((8, 8)))] {
        super::window_events::handle(app, event_loop, window_id, WindowEvent::Ime(event));
    }
    for key in [
        KeyCode::Enter,
        KeyCode::Escape,
        KeyCode::Backspace,
        KeyCode::KeyA,
    ] {
        super::annotations::key(app, key, Some("a"));
    }
    if app
        .state
        .annotations
        .draft
        .as_ref()
        .is_none_or(|draft| !draft.label.is_empty())
        || !app.state.annotations.notes.is_empty()
        || super::annotations::preserve(app)
    {
        return Err("IME keys or scene switch consumed an unfinished composition".into());
    }
    for event in [
        Ime::Preedit(String::new(), None),
        Ime::Commit("检查设备".into()),
        Ime::Disabled,
    ] {
        super::window_events::handle(app, event_loop, window_id, WindowEvent::Ime(event));
    }
    if !app.state.annotations.preedit.is_empty() {
        return Err("IME disable retained preedit".into());
    }
    for event in [
        Ime::Enabled,
        Ime::Preedit("canceled".into(), Some((8, 8))),
        Ime::Disabled,
    ] {
        super::window_events::handle(app, event_loop, window_id, WindowEvent::Ime(event));
    }
    if !app.state.annotations.preedit.is_empty()
        || app
            .state
            .annotations
            .draft
            .as_ref()
            .is_none_or(|draft| draft.label != "检查设备")
    {
        return Err("canceled IME composition changed committed text".into());
    }
    super::annotations::key(app, KeyCode::Enter, None);
    if app.state.annotations.notes.len() != 1 {
        return Err("annotation input was not committed".into());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let folder = std::env::temp_dir().join(format!(
        "native-annotation-probe-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir(&folder).map_err(|e| e.to_string())?;
    let path = folder.join("notes.json");
    let result = (|| {
        app.state.annotations.save(&path, "probe-scene")?;
        app.state.annotations.notes.clear();
        app.state.annotations.load(&path, "probe-scene", &[id])?;
        let note = &app.state.annotations.notes[0];
        if note.label != "检查设备" || note.object != id || note.point != point {
            return Err("annotation restoration changed identity or coordinates".into());
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir(&folder);
    app.state.annotations = Default::default();
    result
}

fn dispatch(app: &mut NativeApp, event_loop: &ActiveEventLoop, pixel: [f64; 2]) {
    let window_id = app.window.as_ref().expect("probe window exists").id();
    for event in [
        WindowEvent::CursorMoved {
            device_id: DeviceId::dummy(),
            position: winit::dpi::PhysicalPosition::new(pixel[0], pixel[1]),
        },
        WindowEvent::MouseInput {
            device_id: DeviceId::dummy(),
            state: ElementState::Pressed,
            button: MouseButton::Left,
        },
    ] {
        super::window_events::handle(app, event_loop, window_id, event);
    }
}
