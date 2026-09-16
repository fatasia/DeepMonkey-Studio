use super::*;
use crate::{
    chart::{ChartAction, DatasetRowsUpdate},
    deep2d::*,
    runtime_package::parse_and_validate_runtime_package,
};

fn loaded() -> LoadedDashboard {
    parse_and_validate_runtime_package(include_bytes!(
        "../../../deep-engine/fixtures/dashboard-composition-v1.json"
    ))
    .unwrap()
    .dashboard
    .unwrap()
}
fn ids(runtime: &DashboardRuntime) -> Vec<String> {
    runtime.document().pages[0]
        .nodes
        .iter()
        .filter(|n| n.chart.is_some())
        .map(|n| n.id.clone())
        .collect()
}
fn message(chart: &ChartRuntime) -> ChartDataMessage {
    ChartDataMessage {
        schema: "deep-engine.chart-data-update".into(),
        schema_version: 1,
        chart_id: chart.source().id.clone(),
        expected_data_revision: chart.data_revision(),
        data_revision: chart.data_revision() + 1,
        datasets: vec![DatasetRowsUpdate::Replace {
            dataset_id: chart.source().datasets[0].id.clone(),
            rows: chart.source().datasets[0].rows.iter().cloned().collect(),
        }],
    }
}
#[test]
fn two_charts_use_node_dimensions_and_update_independently() {
    let mut runtime = DashboardRuntime::new(loaded()).unwrap();
    let ids = ids(&runtime);
    let before = runtime.chart(&ids[1]).unwrap().clone();
    let chart = runtime.chart(&ids[0]).unwrap();
    assert_eq!(
        [
            chart.frame().display_list().logical_width,
            chart.frame().display_list().logical_height
        ],
        [420.0, 300.0]
    );
    let mut update = message(chart);
    if let DatasetRowsUpdate::Replace { rows, .. } = &mut update.datasets[0] {
        rows[0][1] = serde_json::json!(3);
    }
    runtime.apply_data(&ids[0], update).unwrap();
    assert_eq!(runtime.chart(&ids[0]).unwrap().data_revision(), 1);
    assert_eq!(
        runtime.chart(&ids[1]).unwrap().data_revision(),
        before.data_revision()
    );
    assert!(std::ptr::eq(
        runtime.chart(&ids[1]).unwrap().frame(),
        before.frame()
    ));
    let content = runtime.content().clone();
    let mut wrong = message(runtime.chart(&ids[0]).unwrap());
    wrong.chart_id = before.source().id.clone();
    assert!(runtime.apply_data(&ids[0], wrong).is_err());
    assert_eq!(runtime.content(), &content);
}
#[test]
fn simulation_candidates_keep_both_cursors_on_failure() {
    let mut runtime = DashboardRuntime::new(loaded()).unwrap();
    let ids = ids(&runtime);
    assert_eq!(runtime.next_due_ms().unwrap(), Some(0));
    let original = runtime.clone();
    runtime.revision = 9_007_199_254_740_991;
    assert!(runtime.tick(0).is_err());
    assert_eq!(runtime.next_due_ms().unwrap(), Some(0));
    for id in &ids {
        assert_eq!(runtime.chart(id).unwrap().data_revision(), 0);
    }
    assert_eq!(runtime.content(), original.content());
    runtime.revision = 1;
    assert!(runtime.tick(0).unwrap());
    for id in &ids {
        assert_eq!(runtime.chart(id).unwrap().data_revision(), 1);
    }
    assert!(runtime.next_due_ms().unwrap().unwrap() > 0);
    assert_eq!(original.next_due_ms().unwrap(), Some(0));
}
#[test]
fn page_switch_is_atomic_and_clears_old_hover() {
    let mut runtime = DashboardRuntime::new(loaded()).unwrap();
    let id = ids(&runtime)[0].clone();
    runtime
        .charts
        .get_mut(&id)
        .unwrap()
        .dispatch(ChartAction::HoverEnd)
        .unwrap();
    let old = runtime.content().clone();
    assert!(runtime.switch_page("missing").is_err());
    assert_eq!(runtime.content(), &old);
    let page = runtime.document().pages[1].id.clone();
    assert!(runtime.switch_page(&page).unwrap());
    assert_eq!(runtime.active_page_id(), page);
    assert_eq!(runtime.next_due_ms().unwrap(), None);
    assert!(!runtime.switch_page(&page).unwrap());
}
#[test]
fn composition_rejects_a_bad_layer_without_replacing_the_frame() {
    let mut runtime = DashboardRuntime::new(loaded()).unwrap();
    let id = ids(&runtime)[0].clone();
    let content = runtime.content().clone();
    Arc::make_mut(&mut runtime.loaded).document.pages[0].nodes[0].clip =
        Some([0.0, 0.0, f64::NAN, 30.0]);
    let update = message(runtime.chart(&id).unwrap());
    assert!(runtime.apply_data(&id, update).is_err());
    assert_eq!(runtime.chart(&id).unwrap().data_revision(), 0);
    assert_eq!(runtime.content(), &content);
}
#[test]
fn hit_routes_overlapping_nodes_by_z_and_applies_local_clip() {
    let mut source = loaded();
    let static_id = source.document.pages[0].nodes[0].deep2d.clone().unwrap();
    let mut node = source.document.pages[0].nodes[0].clone();
    node.hit_id = Some(node.id.clone());
    node.frame = [10.0, 20.0, 960.0, 640.0];
    node.clip = Some([20.0, 20.0, 100.0, 100.0]);
    // Reuse valid background geometry on two layers; runtime namespaces local resources.
    let mut top = node.clone();
    top.id = "node.top".into();
    top.hit_id = Some(top.id.clone());
    top.z_order = 1;
    top.deep2d = Some("static.top".into());
    top.clip = Some([24.0, 24.0, 10.0, 10.0]);
    source
        .deep2d
        .insert("static.top".into(), source.deep2d[&static_id].clone());
    source.document.pages[0].nodes = vec![node.clone(), top.clone()];
    let runtime = DashboardRuntime::new(source).unwrap();
    assert_eq!(runtime.hit([39.0, 49.0]).unwrap().node_id, top.id);
    assert_eq!(runtime.hit([60.0, 70.0]).unwrap().node_id, node.id);
    assert!(runtime.hit([140.0, 160.0]).is_none());
    let list = runtime.content().display_list();
    let ids: std::collections::BTreeSet<_> = list
        .resources
        .iter()
        .map(|r| match r {
            Deep2dResource::Path(p) => &p.id,
            Deep2dResource::Image(i) => &i.id,
            Deep2dResource::Font(f) => &f.id,
        })
        .collect();
    assert_eq!(ids.len(), list.resources.len());
    assert!(ids.iter().all(|id| id.len() <= 128));
}

#[test]
fn empty_chart_surface_preserves_axis_tooltip_routing_and_clip() {
    let mut source = loaded();
    for chart in source.charts.values_mut() {
        chart.tooltip.enabled = true;
        chart.tooltip.trigger = crate::chart::interaction_contract::TooltipTrigger::Axis;
        chart.actions.clear();
        chart.data_zoom.clear();
    }
    let mut runtime = DashboardRuntime::new(source).unwrap();
    let id = ids(&runtime)[0].clone();
    let node = runtime.document().pages[0]
        .nodes
        .iter()
        .find(|n| n.id == id)
        .unwrap()
        .clone();
    let chart = runtime.chart(&id).unwrap();
    let point = chart.frame().line_point_position("line", 0).unwrap();
    let mut expected = chart.clone();
    // Empty space at the datum's X still triggers the chart's axis tooltip.
    let local = [point[0], 1.0];
    assert!(expected.pointer_move(local[0], local[1]).unwrap());
    assert!(expected.state().tooltip.is_some());
    let global = [local[0] + node.frame[0], local[1] + node.frame[1]];
    assert_eq!(runtime.hit(global).unwrap().node_id, id);
    assert!(runtime.pointer(Some(global), false).unwrap());
    assert_eq!(runtime.chart(&id).unwrap().state(), expected.state());
    runtime
        .pointer(Some([global[0], node.frame[1] - 1.0]), false)
        .unwrap();
    assert!(runtime.chart(&id).unwrap().state().tooltip.is_none());
}
