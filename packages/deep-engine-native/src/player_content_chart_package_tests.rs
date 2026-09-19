//! 图表包加载的 bin 侧合同:from_package 重建 ChartRuntime、sim 宿主与可呈现展示列表。
use super::*;

fn dynamic_package() -> LoadedRuntimePackage {
    deep_engine_native::runtime_package::parse_and_validate_runtime_package(include_bytes!(
        "../../deep-engine/fixtures/chart-runtime-v1.json"
    ))
    .unwrap()
}

#[test]
fn v7_dynamic_runtime_is_carried_into_player_content_for_replay_consumers() {
    let mut package = dynamic_package();
    package.dynamic_runtime = Some(
        serde_json::from_value(serde_json::json!({
            "schema": "deep-engine.dynamic-runtime",
            "schemaVersion": 1,
            "id": "scene.dynamic",
            "revision": 7,
            "animation": {
                "schema": "deep-engine.dynamic-animation",
                "schemaVersion": 1,
                "durationMs": 1000,
                "tracks": [{
                    "targetId": "model-a",
                    "property": "translation",
                    "keyframes": [
                        {"timeMs": 0, "value": [0, 0, 0, 0, 0, 0, 1]},
                        {"timeMs": 1000, "value": [1, 0, 0, 0, 0, 0, 1]}
                    ]
                }]
            }
        }))
        .unwrap(),
    );
    let content = PlayerContent::from_package(package).unwrap();
    let runtime = content
        .dynamic_runtime
        .as_ref()
        .expect("v7 dynamic runtime should reach player content");
    assert_eq!(runtime.revision, 7);
    assert_eq!(runtime.animation.as_ref().unwrap().tracks.len(), 1);
}

#[test]
fn chart_package_builds_runtime_sim_host_and_presentable_display_list() {
    let content = PlayerContent::from_package(dynamic_package()).unwrap();
    let chart = content.chart.as_ref().expect("chart runtime from package");
    assert_eq!(chart.source().id, "chart-v1-golden");
    assert_eq!(chart.source().series.len(), 6);
    assert!(content.chart_sim.is_some());
    let list = match content.deep2d.as_ref().expect("chart presentation") {
        Deep2dRuntimeContent::DisplayList(list) => list,
        Deep2dRuntimeContent::Package(_) | Deep2dRuntimeContent::Composite(_) => {
            panic!("chart package must present a display list")
        }
    };
    assert!(list.logical_width > 0.0);
    assert!(!list.commands.is_empty());
    // 图表包无相机:初始视图取默认值,包快照仍然绑定。
    assert_eq!(content.initial_view(), Default::default());
    assert!(content.runtime_package().is_some());
}

#[test]
fn chart_package_interacts_and_reloads_without_losing_chart_state() {
    let mut content = PlayerContent::from_package(dynamic_package()).unwrap();
    let before = content.chart.as_ref().unwrap().source().series.len();
    content
        .chart
        .as_mut()
        .unwrap()
        .dispatch(deep_engine_native::chart::ChartAction::ResetZoom)
        .unwrap();
    assert_eq!(
        content.chart.as_ref().unwrap().source().series.len(),
        before
    );
    // 换包:同源重载重建 sim 宿主;视图语义与既有 from_package 合同一致。
    let next = PlayerContent::from_package(dynamic_package()).unwrap();
    assert_eq!(
        next.view_after_reload(&content, content.initial_view()),
        next.initial_view()
    );
    assert!(next.chart_sim.is_some());
}
