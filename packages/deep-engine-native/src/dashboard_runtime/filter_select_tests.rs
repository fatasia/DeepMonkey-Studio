use super::*;
use crate::deep2d::*;
use std::time::{Duration, Instant};

pub(super) fn fixture() -> LoadedDashboard {
    let mut loaded = super::filter_tests::fixture();
    let filter = loaded.document.filter.as_mut().unwrap();
    filter.presentation = Some(
        serde_json::from_value(
            serde_json::json!({"kind":"select-v1","rowHeight":32,"visibleRows":8}),
        )
        .unwrap(),
    );
    let base = filter.options[0].clone();
    let empty = filter.options[1].clone();
    filter.options = (0..25)
        .map(|index| {
            let mut option = if index == 24 {
                empty.clone()
            } else {
                base.clone()
            };
            option.value = format!("Option {index}");
            option
        })
        .collect();
    let node = &loaded.document.pages[0].nodes[0];
    let id = node.deep2d.as_ref().unwrap();
    let list = loaded.deep2d[id].display_list().clone();
    let package = serde_json::from_value(serde_json::json!({
        "schema":"deep-engine.deep2d-runtime", "schemaVersion":2, "id":id, "revision":1,
        "composition":"z-ordered", "displayList":list,
        "atlases":[{"id":"glyphs","revision":1,"kind":"image","format":"rgba8unorm-srgb","width":1,"height":1,"sampling":"linear","dataBase64":"/////w=="}],
        "quads":(0..25).map(|i| serde_json::json!({"id":format!("q{i}"),"zOrder":i+1,"transform":[1,0,0,1,0,0],"atlasId":"glyphs","source":[0,0,1,1],"destination":[17,17,20,20],"color":[1,1,1,1]})).collect::<Vec<_>>()
    })).unwrap();
    loaded
        .deep2d
        .insert(id.clone(), Deep2dRuntimeContent::Package(package));
    loaded
}
fn runtime() -> DashboardRuntime {
    DashboardRuntime::new(fixture()).unwrap()
}

#[test]
fn select_keyboard_reveals_last_and_commits_only_with_enter() {
    let mut runtime = runtime();
    assert_eq!(runtime.select_key("End").unwrap(), None);
    runtime.select_key("Tab").unwrap();
    runtime.select_key("Enter").unwrap();
    assert!(runtime.select_ui.open);
    runtime.select_key("End").unwrap();
    assert_eq!(runtime.selected_filter(), Some(0));
    assert_eq!(runtime.select_ui.highlighted, 24);
    assert!(runtime.select_ui.first > 16);
    let node = runtime.select_node().unwrap();
    let painted =
        runtime.select_content(&runtime.loaded.deep2d[node.deep2d.as_ref().unwrap()], true);
    let Deep2dRuntimeContent::Package(package) = painted else {
        panic!("expected glyph package");
    };
    assert!(package.quads.iter().any(|quad| quad.id == "q24"));
    assert!(package.quads.len() <= 8);
    assert!(package.quads.iter().all(|q| q.destination[1] >= 0.0
        && q.destination[1] + q.destination[3] <= package.display_list.logical_height));
    runtime.select_key("Escape").unwrap();
    assert_eq!(runtime.selected_filter(), Some(0));
    runtime.select_key("Enter").unwrap();
    runtime.select_key("End").unwrap();
    runtime.select_key("Enter").unwrap();
    assert_eq!(runtime.selected_filter(), Some(24));
    assert!(!runtime.select_ui.open);
    let target = &runtime.document().filter.as_ref().unwrap().options[24].updates[0].node_id;
    assert!(
        runtime
            .chart(target)
            .unwrap()
            .source()
            .datasets
            .iter()
            .all(|d| d.rows.is_empty())
    );
    runtime.select_key("Enter").unwrap();
    assert_eq!(runtime.select_ui.highlighted, 24);
    runtime.select_key("Home").unwrap();
    assert_eq!(runtime.select_ui.first, 0);
    runtime.select_key("ArrowDown").unwrap();
    runtime.select_key("ArrowUp").unwrap();
    assert_eq!(runtime.select_ui.highlighted, 0);
}

#[test]
fn select_scroll_pointer_focus_and_cancel_use_the_real_runtime() {
    let mut runtime = runtime();
    let (header, panel, rows) = runtime.select_geometry().unwrap();
    runtime
        .pointer(Some([header[0] + 2.0, header[1] + 2.0]), true)
        .unwrap();
    assert!(runtime.select_ui.open);
    for _ in 0..30 {
        runtime
            .zoom_at([panel[0] + 2.0, panel[1] + 2.0], -1.0)
            .unwrap();
    }
    assert_eq!(runtime.select_ui.first, 25 - rows);
    assert!(
        (runtime.select_ui.first..runtime.select_ui.first + rows)
            .contains(&runtime.select_ui.highlighted)
    );
    assert_eq!(runtime.selected_filter(), Some(0));
    runtime
        .pointer(
            Some([panel[0] + 2.0, panel[1] + (rows as f64 - 0.5) * 32.0]),
            true,
        )
        .unwrap();
    assert_eq!(runtime.selected_filter(), Some(24));
    runtime.select_key("Enter").unwrap();
    runtime.pointer(Some([0.0, 0.0]), true).unwrap();
    assert!(!runtime.select_ui.open);
    assert!(!runtime.select_ui.focused);
    runtime.select_key("Tab").unwrap();
    runtime.select_key("Enter").unwrap();
    runtime.blur_select().unwrap();
    assert!(!runtime.select_ui.open);
    assert_eq!(runtime.selected_filter(), Some(24));
}

#[test]
fn select_failure_rolls_back_and_legacy_profile_remains_a_list() {
    let mut runtime = runtime();
    runtime.select_key("Tab").unwrap();
    runtime.select_key("Enter").unwrap();
    runtime.select_key("End").unwrap();
    runtime.revision = 9_007_199_254_740_991;
    assert!(runtime.select_key("Enter").is_err());
    assert_eq!(runtime.selected_filter(), Some(0));
    assert!(runtime.select_ui.open);
    let mut old = DashboardRuntime::new(super::filter_tests::fixture()).unwrap();
    assert_eq!(old.select_key("Tab").unwrap(), None);
    assert!(old.focus_filter(1).unwrap());
    let mut invalid = fixture();
    invalid
        .document
        .filter
        .as_mut()
        .unwrap()
        .presentation
        .as_mut()
        .unwrap()
        .row_height = 0.0;
    assert!(DashboardRuntime::new(invalid).is_err());
}

#[test]
fn tooltip_and_upwards_popup_are_composed_above_page_content_and_blur_closes_them() {
    let mut loaded = fixture();
    let node = &mut loaded.document.pages[0].nodes[0];
    node.frame[1] = 560.0;
    let id = node.deep2d.as_ref().unwrap();
    let Deep2dRuntimeContent::Package(package) = loaded.deep2d.get_mut(id).unwrap() else {
        panic!("package");
    };
    let mut tip = package.quads[0].clone();
    tip.id = "tooltip-label".into();
    tip.z_order = 1001;
    package.quads.push(tip);
    let mut runtime = DashboardRuntime::new(loaded).unwrap();
    let (header, panel, _) = runtime.select_geometry().unwrap();
    assert!(panel[1] < header[1]);
    runtime
        .pointer(Some([header[0] + 2.0, header[1] + 2.0]), false)
        .unwrap();
    let clip = Deep2dRect {
        x: 0.0,
        y: 0.0,
        width: 1280.0,
        height: 720.0,
    };
    assert!(runtime.select_tooltip_layer(clip).is_some());
    runtime.blur_select().unwrap();
    assert!(runtime.select_tooltip_layer(clip).is_none());
    runtime.select_key("Tab").unwrap();
    runtime.select_key("Enter").unwrap();
    assert!(runtime.select_popup_layer(clip).is_some());
    runtime.select_key("Tab").unwrap();
    assert!(!runtime.select_ui.open);
    assert!(!runtime.select_ui.focused);
}

#[test]
fn missing_or_oversized_option_glyphs_are_rejected_before_runtime_acceptance() {
    for missing in [true, false] {
        let mut loaded = fixture();
        let id = loaded.document.pages[0].nodes[0].deep2d.as_ref().unwrap();
        let Deep2dRuntimeContent::Package(package) = loaded.deep2d.get_mut(id).unwrap() else {
            panic!("package");
        };
        if missing {
            package.quads.pop();
        } else {
            package.quads[0].destination[3] = 100.0;
        }
        assert!(DashboardRuntime::new(loaded).is_err());
    }
}

#[test]
fn select_typeahead_uses_published_values_and_enter_keeps_atomic_commit() {
    let mut loaded = fixture();
    let filter = loaded.document.filter.as_mut().unwrap();
    for (index, value) in ["Alpha", "Alpine", "Beta", "北京", "上海"]
        .into_iter()
        .enumerate()
    {
        filter.options[index].value = value.into();
    }
    let mut runtime = DashboardRuntime::new(loaded).unwrap();
    runtime.select_key("Tab").unwrap();
    let started = Instant::now();
    assert!(runtime.select_text_at("b", started).unwrap());
    assert!(runtime.select_ui.open);
    assert_eq!(runtime.select_ui.highlighted, 2);
    assert_eq!(runtime.selected_filter(), Some(0));
    assert!(
        runtime
            .select_text_at("e", started + Duration::from_millis(100))
            .unwrap()
    );
    assert_eq!(runtime.select_ui.typeahead, "be");
    runtime.select_key("Enter").unwrap();
    assert_eq!(runtime.selected_filter(), Some(2));
    assert!(runtime.select_ui.typeahead.is_empty());

    runtime.select_key("Enter").unwrap();
    assert!(
        runtime
            .select_text_at("北", started + Duration::from_secs(2))
            .unwrap()
    );
    assert_eq!(runtime.select_ui.highlighted, 3);
}

#[test]
fn select_typeahead_resets_after_timeout_and_ignores_control_only_text() {
    let mut loaded = fixture();
    let filter = loaded.document.filter.as_mut().unwrap();
    filter.options[1].value = "Alpha".into();
    filter.options[2].value = "Beta".into();
    let mut runtime = DashboardRuntime::new(loaded).unwrap();
    runtime.select_key("Tab").unwrap();
    let started = Instant::now();
    assert!(!runtime.select_text_at("\n", started).unwrap());
    runtime.select_text_at("a", started).unwrap();
    assert_eq!(runtime.select_ui.highlighted, 1);
    runtime
        .select_text_at("b", started + Duration::from_secs(1))
        .unwrap();
    assert_eq!(runtime.select_ui.typeahead, "b");
    assert_eq!(runtime.select_ui.highlighted, 2);
}
