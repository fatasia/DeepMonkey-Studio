use super::*;
use winit::event::Ime;
pub(super) fn fixture() -> LoadedDashboard {
    let mut loaded = super::filter_tests::fixture();
    loaded.document.filter = None;
    let fonts = cosmic_text::FontSystem::new();
    let face = fonts
        .db()
        .faces()
        .find(|f| {
            f.weight.0 == 400
                && f.style == cosmic_text::Style::Normal
                && f.families
                    .iter()
                    .any(|(n, _)| ["Arial", "DejaVu Sans", "Liberation Sans"].contains(&n.as_str()))
        })
        .expect("Latin fixture font");
    let font = fonts
        .db()
        .with_face_data(face.id, |bytes, index| {
            serde_json::json!({
                "sha256": crate::shader_package::hash::sha256(bytes), "faceIndex": index,
                "dataBase64": crate::deep2d::encode_base64(bytes)
            })
        })
        .unwrap();
    let nodes = &loaded.document.pages[0].nodes;
    let chart = &loaded.charts[nodes[1].chart.as_ref().unwrap()];
    loaded.document.text_input = Some(serde_json::from_value(serde_json::json!({
        "kind":"text-v1","nodeId":nodes[0].id,"key":"category","locale":"en-US","match":"contains","maxGraphemes":256,
        "fonts":[font],"style":{"fontSize":14,"lineHeight":20,"fontWeight":400,"fontStyle":"normal","color":[255,255,255,255]},
        "bindings":[{"nodeId":nodes[1].id,"datasetId":chart.datasets[0].id,"rows":chart.datasets[0].rows}]
    })).unwrap());
    loaded
}
#[test]
fn real_runtime_edits_ime_and_chart_data_commit_atomically() {
    let mut runtime = DashboardRuntime::new(fixture()).unwrap();
    runtime.input_focus(true).unwrap();
    let target = runtime.document().text_input.as_ref().unwrap().bindings[0]
        .node_id
        .clone();
    let original = runtime.chart(&target).unwrap().source().datasets[0]
        .rows
        .clone();
    runtime
        .input_ime(Ime::Preedit("missing".into(), None))
        .unwrap();
    assert_eq!(runtime.input_value(), "");
    assert_eq!(
        runtime.chart(&target).unwrap().source().datasets[0].rows,
        original
    );
    runtime.input_ime(Ime::Commit("missing".into())).unwrap();
    assert!(
        runtime.chart(&target).unwrap().source().datasets[0]
            .rows
            .is_empty()
    );
    runtime.input_key("KeyZ", None, true, false).unwrap();
    assert_eq!(runtime.input_value(), "");
    assert_eq!(
        runtime.chart(&target).unwrap().source().datasets[0].rows,
        original
    );
    let revision = runtime.revision;
    assert!(runtime.input_ime(Ime::Commit("\n".into())).is_err());
    assert_eq!(runtime.revision, revision);
    assert_eq!(runtime.input_value(), "");
    runtime
        .input_key("KeyA", Some("all"), false, false)
        .unwrap();
    assert_eq!(
        runtime.chart(&target).unwrap().source().datasets[0].rows,
        original
    );
    let frame = runtime.input_node().unwrap().frame;
    runtime
        .input_pointer(Some([frame[0] + 18.0, frame[1] + 22.0]))
        .unwrap();
    assert_eq!(runtime.input_ui.editor.caret, 0);
    let data_revision = runtime.chart(&target).unwrap().data_revision();
    runtime.input_key("End", None, false, false).unwrap();
    assert_eq!(
        runtime.chart(&target).unwrap().data_revision(),
        data_revision
    );
    assert!(runtime.input_caret_rect().unwrap().unwrap()[0] > frame[0] + 21.0);
    runtime.input_key("KeyA", None, true, false).unwrap();
    runtime.input_key("Backspace", None, false, false).unwrap();
    assert_eq!(runtime.input_value(), "");
    runtime
        .input_ime(Ime::Preedit("pending".into(), None))
        .unwrap();
    runtime.input_focus(false).unwrap();
    assert_eq!(runtime.input_preedit(), "");
    crate::deep2d::prepare_runtime_content(runtime.content()).unwrap();
}
#[test]
fn invalid_input_font_and_incompatible_binding_are_rejected() {
    let mut loaded = fixture();
    loaded.document.text_input.as_mut().unwrap().fonts[0].sha256 = "0".repeat(64);
    assert!(DashboardRuntime::new(loaded).is_err());
    let mut loaded = fixture();
    loaded.document.text_input.as_mut().unwrap().bindings[0]
        .rows
        .clear();
    assert!(DashboardRuntime::new(loaded).is_err());
}

#[test]
fn clipboard_mutations_and_pointer_selection_share_editor_history() {
    let mut runtime = DashboardRuntime::new(fixture()).unwrap();
    runtime.input_focus(true).unwrap();
    runtime.input_paste("East\r\n West").unwrap();
    assert_eq!(runtime.input_value(), "East West");
    let [x, y, _, _] = runtime.input_node().unwrap().frame;
    runtime
        .input_pointer_select(Some([x + 22.0, y + 22.0]), false, true)
        .unwrap();
    assert_eq!(runtime.input_selected_text(), Some("East"));
    runtime.input_cut_selection().unwrap();
    assert_eq!(runtime.input_value(), " West");
    runtime.input_key("KeyZ", None, true, false).unwrap();
    assert_eq!(runtime.input_value(), "East West");
    runtime.input_pointer(Some([x + 18.0, y + 22.0])).unwrap();
    let anchor = runtime.input_selection_anchor();
    runtime.input_drag_selection(x + 10000.0, anchor).unwrap();
    assert_eq!(runtime.input_selected_text(), Some("East West"));
    runtime.input_paste("all").unwrap();
    assert_eq!(runtime.input_value(), "all");
    let before = runtime.content.clone();
    assert!(runtime.input_paste(&"x".repeat(257)).is_err());
    assert!(Arc::ptr_eq(&before, &runtime.content));
    assert_eq!(runtime.input_value(), "all");
}
