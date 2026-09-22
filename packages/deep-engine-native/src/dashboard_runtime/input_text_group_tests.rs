use super::*;
#[test]
fn two_real_inputs_keep_independent_edits_and_intersect_filters() {
    let mut loaded = super::input_text_tests::fixture();
    let first = loaded.document.text_input.take().unwrap();
    let mut second = first.clone();
    second.node_id = format!("node.{}", "e".repeat(64));
    second.key = "second".into();
    let mut node = loaded.document.pages[0]
        .nodes
        .iter()
        .find(|n| n.id == first.node_id)
        .unwrap()
        .clone();
    node.id = second.node_id.clone();
    node.hit_id = Some(node.id.clone());
    node.frame[1] += 80.0;
    loaded.document.pages[0].nodes.insert(1, node);
    let first_id = first.node_id.clone();
    let second_id = second.node_id.clone();
    let target = first.bindings[0].node_id.clone();
    let category = first.bindings[0].rows[0][0].as_str().unwrap().to_owned();
    loaded.document.text_inputs = vec![first, second];
    let mut runtime = DashboardRuntime::new(loaded).unwrap();
    runtime.focus_step(false).unwrap();
    assert_eq!(runtime.focused_control(), Some(first_id.clone()));
    runtime.input_paste(&category).unwrap();
    let rows = runtime.chart(&target).unwrap().source().datasets[0]
        .rows
        .clone();
    assert!(!rows.is_empty());
    runtime.focus_step(false).unwrap();
    assert_eq!(runtime.focused_control(), Some(second_id.clone()));
    runtime.input_paste("missing").unwrap();
    assert!(
        runtime.chart(&target).unwrap().source().datasets[0]
            .rows
            .is_empty()
    );
    runtime.input_key("KeyA", None, true, false).unwrap();
    runtime.input_key("Delete", None, false, false).unwrap();
    assert_eq!(
        runtime.chart(&target).unwrap().source().datasets[0].rows,
        rows
    );
    runtime
        .input_ime(winit::event::Ime::Preedit("draft".into(), None))
        .unwrap();
    runtime.focus_step(true).unwrap();
    assert_eq!(runtime.focused_control(), Some(first_id.clone()));
    assert_eq!(runtime.input_value(), category);
    assert_eq!(runtime.input_preedit(), "");
    runtime.focus_step(false).unwrap();
    assert_eq!(runtime.input_value_for(&second_id), Some(""));
    assert_eq!(runtime.input_preedit(), "");
    runtime.focus_step(false).unwrap();
    assert_eq!(runtime.focused_control(), None);
    runtime.focus_step(true).unwrap();
    assert_eq!(runtime.focused_control(), Some(second_id));
    crate::deep2d::prepare_runtime_content(runtime.content()).unwrap();
}

#[test]
fn text_and_select_intersect_in_both_orders_and_clear_restores_selected_variant() {
    let mut loaded = super::input_text_tests::fixture();
    let mut filter = super::filter_tests::fixture().document.filter.unwrap();
    let mut node = loaded.document.pages[0].nodes[0].clone();
    node.id = format!("node.{}", "d".repeat(64));
    node.hit_id = Some(node.id.clone());
    node.frame[1] += 100.0;
    filter.node_id = node.id.clone();
    loaded.document.pages[0].nodes.push(node);
    let binding = loaded.document.text_input.as_ref().unwrap().bindings[0].clone();
    let category = binding.rows[0][0].as_str().unwrap().to_owned();
    // A different-dimension select changes the aggregate, not just category membership.
    let mut regional = filter.options[0].clone();
    regional.value = "subset".into();
    regional.updates[0].datasets[0].rows = vec![binding.rows[0].clone()].into();
    regional.updates[0].datasets[0].rows[0][1] = serde_json::json!(3);
    let expected = regional.updates[0].datasets[0].rows.clone();
    filter.options.push(regional);
    loaded.document.filter = Some(filter);
    let mut runtime = DashboardRuntime::new(loaded).unwrap();
    runtime.input_focus(true).unwrap();
    runtime.input_paste(&category).unwrap();
    runtime.focus_filter(1).unwrap();
    assert!(
        runtime.chart(&binding.node_id).unwrap().source().datasets[0]
            .rows
            .is_empty()
    );
    runtime.focus_filter(2).unwrap();
    assert_eq!(
        runtime.chart(&binding.node_id).unwrap().source().datasets[0].rows,
        expected
    );
    runtime.input_key("KeyA", None, true, false).unwrap();
    runtime.input_paste("missing").unwrap();
    runtime.focus_filter(0).unwrap();
    assert!(
        runtime.chart(&binding.node_id).unwrap().source().datasets[0]
            .rows
            .is_empty()
    );
    runtime.focus_filter(2).unwrap();
    runtime.input_key("KeyA", None, true, false).unwrap();
    runtime.input_key("Delete", None, false, false).unwrap();
    assert_eq!(
        runtime.chart(&binding.node_id).unwrap().source().datasets[0].rows,
        expected
    );
    runtime.focus_filter(0).unwrap();
    assert_eq!(
        runtime.chart(&binding.node_id).unwrap().source().datasets[0].rows,
        binding.rows
    );
}

#[test]
fn mixed_controls_share_focus_and_cancel_composition_on_tab() {
    let mut loaded = super::filter_select_tests::fixture();
    let source = super::input_text_tests::fixture();
    let mut input = source.document.text_input.unwrap();
    let mut node = loaded.document.pages[0].nodes[0].clone();
    node.id = format!("node.{}", "f".repeat(64));
    node.hit_id = Some(node.id.clone());
    node.frame[1] += 100.0;
    input.node_id = node.id.clone();
    loaded.document.pages[0].nodes.push(node);
    loaded.document.text_input = Some(input);
    let mut runtime = DashboardRuntime::new(loaded).unwrap();
    runtime.focus_step(false).unwrap();
    assert!(runtime.select_ui.focused);
    runtime.select_key("Enter").unwrap();
    assert!(runtime.select_ui.open);
    runtime.focus_step(false).unwrap();
    assert!(runtime.input_focused());
    assert!(!runtime.select_ui.open && !runtime.select_ui.focused);
    runtime
        .input_ime(winit::event::Ime::Preedit("draft".into(), None))
        .unwrap();
    runtime.focus_step(true).unwrap();
    assert!(runtime.select_ui.focused && !runtime.input_focused());
    assert_eq!(runtime.input_preedit(), "");
    assert_eq!(runtime.input_value(), "");
}
