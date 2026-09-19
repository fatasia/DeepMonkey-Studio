use super::NativeApp;
use crate::player_annotations::Annotation;
use std::path::PathBuf;
use winit::keyboard::KeyCode;

pub(super) fn key(app: &mut NativeApp, key: KeyCode, text: Option<&str>) -> bool {
    if app.state.annotations.draft.is_some() && !app.state.annotations.preedit.is_empty() {
        return true;
    }
    if app.state.annotations.draft.is_some() {
        match key {
            KeyCode::Escape => {
                app.state.annotations.draft = None;
                end_edit(app);
                status(app, "annotation canceled");
            }
            KeyCode::Enter => {
                if app.state.annotations.commit() {
                    end_edit(app);
                    status(app, "annotation added; F5 saves");
                }
            }
            KeyCode::Backspace => {
                edit(app, |editor| editor.backspace());
            }
            _ => {
                if let Some(text) = text {
                    append(app, text);
                }
            }
        }
        return true;
    }
    match key {
        KeyCode::KeyA => {
            if let (Some(object), Some(point)) = (&app.state.selected, app.state.selected_point) {
                app.state.annotations.draft = Some(Annotation {
                    object: object.clone(),
                    point,
                    label: String::new(),
                });
                app.annotation_editor = None;
                if let Some(window) = &app.window {
                    window.set_ime_allowed(true);
                }
                super::annotation_ime_area::refresh_current(app);
                preview(app);
            } else {
                status(app, "select an object before adding an annotation");
            }
        }
        KeyCode::F5 => {
            let result =
                location(app).and_then(|(path, key)| app.state.annotations.save(&path, &key));
            report(app, result, "annotations saved");
        }
        KeyCode::F9 => {
            if !preserve(app) {
                return true;
            }
            let result = location(app).and_then(|(path, key)| {
                let objects: Vec<_> = app
                    .content
                    .active()
                    .packet()
                    .instances
                    .iter()
                    .map(|v| v.id.as_str())
                    .collect();
                app.state.annotations.load(&path, &key, &objects)
            });
            report(
                app,
                result,
                "annotations loaded; Tab jumps to an annotation",
            );
        }
        KeyCode::Tab => {
            let notes = &mut app.state.annotations;
            if !notes.notes.is_empty() {
                let index = notes
                    .active
                    .map_or(0, |index| (index + 1) % notes.notes.len());
                notes.active = Some(index);
                let note = &notes.notes[index];
                app.state.selected = Some(note.object.clone());
                app.state.selected_point = Some(note.point);
                app.state.view.target = note.point;
                let label = note.label.clone();
                if let Some(renderer) = &mut app.renderer {
                    renderer.set_view(app.state.view);
                }
                status(app, &label);
                app.request_redraw();
            } else {
                status(app, "no annotations; select an object and press A");
            }
        }
        KeyCode::Delete => {
            if let Some(index) = app.state.annotations.active.take()
                && index < app.state.annotations.notes.len()
            {
                app.state.annotations.notes.remove(index);
                status(app, "annotation removed; F5 saves");
            }
        }
        _ => return false,
    }
    true
}

pub(super) fn append(app: &mut NativeApp, text: &str) {
    edit(app, |editor| editor.append(text));
}

pub(super) fn clear(app: &mut NativeApp) {
    app.state.annotations = Default::default();
    end_edit(app);
}

// Called before touching either renderer or content publication. Failed persistence
// leaves the active scene and all annotations intact; the source may be retried.
pub(super) fn preserve(app: &mut NativeApp) -> bool {
    if !app.state.annotations.dirty() && app.state.annotations.draft.is_none() {
        return true;
    }
    let result = location(app).and_then(|(path, key)| app.state.annotations.preserve(&path, &key));
    let preserved = result.is_ok();
    report(app, result, "annotations saved");
    preserved
}

pub(super) fn ime(app: &mut NativeApp, event: winit::event::Ime) {
    use winit::event::Ime;
    if app.state.annotations.draft.is_none() {
        return;
    }
    if matches!(event, Ime::Enabled) {
        super::annotation_ime_area::refresh_current(app);
    }
    edit(app, |editor| editor.ime(event));
}

pub(super) fn focus(app: &mut NativeApp, focused: bool) {
    if focused {
        super::annotation_ime_area::refresh_current(app);
    }
    edit(app, |editor| {
        editor.focus(focused);
        Ok(())
    });
}

fn edit(
    app: &mut NativeApp,
    action: impl FnOnce(&mut super::annotation_input::AnnotationEditor) -> Result<(), String>,
) {
    let Some(draft) = app.state.annotations.draft.as_mut() else {
        return;
    };
    if app.annotation_editor.is_none() {
        match super::annotation_input::AnnotationEditor::new(&draft.label) {
            Ok(editor) => app.annotation_editor = Some(editor),
            Err(error) => {
                status(app, &error);
                return;
            }
        }
    }
    let editor = app.annotation_editor.as_mut().unwrap();
    if let Err(error) = action(editor) {
        status(app, &format!("annotation input failed: {error}"));
        return;
    }
    draft.label = editor.text().to_owned();
    app.state.annotations.preedit = editor.preedit().to_owned();
    preview(app);
}

fn location(app: &NativeApp) -> Result<(PathBuf, String), String> {
    let content = app.content.active();
    let key = deep_engine_native::runtime_package::runtime_content_sha256(&serde_json::json!({
        "package":content.runtime_package().map(|p|&p.package_id),"content":content.scene_content_key()
    }));
    let root = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    Ok((
        PathBuf::from(root)
            .join("DeepEngineNative/annotations")
            .join(format!("{key}.json")),
        key,
    ))
}

fn end_edit(app: &mut NativeApp) {
    app.annotation_editor = None;
    app.state.annotations.preedit.clear();
    if let Some(window) = &app.window {
        window.set_ime_allowed(false);
    }
}
fn preview(app: &NativeApp) {
    if let Some(draft) = &app.state.annotations.draft {
        status(
            app,
            &format!(
                "annotation: {}{} (Enter confirms, Esc cancels)",
                draft.label, app.state.annotations.preedit
            ),
        );
    }
}
fn status(app: &NativeApp, text: &str) {
    if let Some(window) = &app.window {
        crate::window_chrome::set_title(window, &format!("Deep Engine Native Viewer — {text}"));
    }
}
fn report(app: &NativeApp, result: Result<(), String>, success: &str) {
    match result {
        Ok(()) => status(app, success),
        Err(error) => status(app, &format!("annotation failed: {error}")),
    }
}
