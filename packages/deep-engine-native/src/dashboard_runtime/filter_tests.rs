use super::*;
use crate::runtime_package::parse_and_validate_runtime_package;

pub(super) fn fixture() -> LoadedDashboard {
    let mut loaded = parse_and_validate_runtime_package(include_bytes!(
        "../../../deep-engine/fixtures/dashboard-composition-v1.json"
    ))
    .unwrap()
    .dashboard
    .unwrap();
    let page = &mut loaded.document.pages[0];
    let node_id = page.nodes[0].id.clone();
    page.nodes[0].hit_id = Some(node_id.clone());
    let target = &mut page.nodes[1];
    target.chart_sim = None;
    let chart = &loaded.charts[target.chart.as_ref().unwrap()];
    let updates: Vec<_> = chart
        .datasets
        .iter()
        .map(|dataset| {
            serde_json::json!({
                "datasetId": dataset.id, "rows": dataset.rows,
            })
        })
        .collect();
    let empty: Vec<_> = chart
        .datasets
        .iter()
        .map(|dataset| {
            serde_json::json!({
                "datasetId": dataset.id, "rows": [],
            })
        })
        .collect();
    loaded.document.filter = Some(
        serde_json::from_value(serde_json::json!({
            "nodeId": node_id, "sourceNodeId": "author.filter", "key": "region",
            "options": [
                {"value": "全部", "updates": [{"nodeId": target.id, "datasets": updates}]},
                {"value": "不存在", "updates": [{"nodeId": target.id, "datasets": empty}]}
            ]
        }))
        .unwrap(),
    );
    loaded
}

#[test]
fn filter_dataset_and_selection_commit_together_and_empty_is_real() {
    let mut runtime = DashboardRuntime::new(fixture()).unwrap();
    let target = runtime.document().filter.as_ref().unwrap().options[0].updates[0]
        .node_id
        .clone();
    let original = runtime.chart(&target).unwrap().source().datasets.clone();
    assert_eq!(runtime.selected_filter(), Some(0));
    assert!(runtime.select_filter(1).unwrap());
    assert_eq!(runtime.selected_filter(), Some(1));
    assert!(
        runtime
            .chart(&target)
            .unwrap()
            .source()
            .datasets
            .iter()
            .all(|dataset| dataset.rows.is_empty())
    );
    let content = runtime.content.clone();
    let revision = runtime.revision;
    assert!(!runtime.select_filter(1).unwrap());
    assert!(runtime.select_filter(2).is_err());
    assert_eq!(runtime.selected_filter(), Some(1));
    assert_eq!(runtime.revision, revision);
    assert!(Arc::ptr_eq(&content, &runtime.content));
    assert!(runtime.select_filter(0).unwrap());
    assert_eq!(runtime.chart(&target).unwrap().source().datasets, original);
}

#[test]
fn invalid_profile_target_rows_and_duplicate_values_are_rejected() {
    for case in 0..4 {
        let mut loaded = fixture();
        let filter = loaded.document.filter.as_mut().unwrap();
        match case {
            0 => filter.options[1].value = filter.options[0].value.clone(),
            1 => filter.options[1].updates[0].node_id = filter.node_id.clone(),
            2 => filter.options[1].updates[0].datasets[0].dataset_id = "foreign".into(),
            _ => filter.options[1].updates.clear(),
        }
        assert!(DashboardRuntime::new(loaded).is_err());
    }
}

#[test]
fn failed_rebuild_does_not_publish_filter_or_new_rows() {
    let mut runtime = DashboardRuntime::new(fixture()).unwrap();
    let content = runtime.content.clone();
    runtime.revision = 9_007_199_254_740_991;
    assert!(runtime.select_filter(1).is_err());
    assert_eq!(runtime.selected_filter(), Some(0));
    assert!(Arc::ptr_eq(&content, &runtime.content));
}

#[test]
fn keyboard_focus_is_transactional() {
    let mut runtime = DashboardRuntime::new(fixture()).unwrap();
    assert!(runtime.focus_filter(0).unwrap());
    assert!(runtime.keyboard_filter_focus);
    assert!(!runtime.focus_filter(0).unwrap());
    let before = runtime.content.clone();
    assert!(runtime.focus_filter(99).is_err());
    assert!(Arc::ptr_eq(&before, &runtime.content));
    assert_eq!(runtime.selected_filter(), Some(0));
    runtime.revision = 9_007_199_254_740_991;
    assert!(runtime.focus_filter(1).is_err());
    assert!(runtime.keyboard_filter_focus);
    assert_eq!(runtime.selected_filter(), Some(0));
}

#[test]
fn static_data_layers_switch_with_chart_rows_and_validate_the_closed_target_set() {
    let mut loaded = fixture();
    let mut node = loaded.document.pages[0].nodes[0].clone();
    node.id = format!("node.{}", "c".repeat(64));
    node.hit_id = None;
    node.visible = false;
    node.frame[0] += 20.0;
    let id = node.id.clone();
    loaded.document.pages[0].nodes.push(node);
    let filter = loaded.document.filter.as_mut().unwrap();
    for (index, option) in filter.options.iter_mut().enumerate() {
        option.visibility = serde_json::from_value(serde_json::json!([
            {"nodeId": id, "visible": index == 1}
        ]))
        .unwrap();
    }
    let mut runtime = DashboardRuntime::new(loaded.clone()).unwrap();
    let before = runtime.content.clone();
    assert!(runtime.select_filter(1).unwrap());
    assert_ne!(runtime.content(), before.as_ref());
    assert!(runtime.select_filter(0).unwrap());
    loaded.document.filter.as_mut().unwrap().options[1].visibility[0].node_id = "foreign".into();
    assert!(DashboardRuntime::new(loaded).is_err());
}
