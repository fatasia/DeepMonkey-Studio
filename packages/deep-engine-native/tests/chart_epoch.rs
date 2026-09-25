//! P1-01 全局 Epoch:事务化提交、同源数据推进与失败保持(CPU,无 GPU 依赖)。
// PlayerContent 属 bin target(lib 不导出),按 tests/player_shader_plan.rs 先例拉入源文件;
// 拉入的 bin 侧字段在测试 target 必然 dead_code,与先例同样放行。
#![allow(dead_code)]
#[path = "../src/player_content.rs"]
mod player_content;
#[path = "../src/player_shader_plan.rs"]
mod player_shader_plan;
// player_shader_plan.rs 引用 bin 侧 player_picking（#[path] 重组装的 bin 模块族）。
#[path = "../src/player_picking.rs"]
mod player_picking;
#[path = "../src/runtime_lkg.rs"]
mod runtime_lkg;
// —— player_picking bin 模块族传递闭包（V5 预检同族修复：#[path] 重组装的 bin 侧
// 模块在测试 crate 根必须齐备，缺失见各模块文件内注释的依赖来源）——
#[path = "../src/player_state.rs"]
mod player_state; // player_state.rs 被 player_picking/publication_verification 等引用
#[path = "../src/player_measurement.rs"]
mod player_measurement; // player_measurement.rs 被 player_picking/publication_verification 等引用
#[path = "../src/player_annotations.rs"]
mod player_annotations;
// player_state 字段引用的验证记录数据（依赖倒置后无服务层依赖）。
#[path = "../src/publication_record.rs"]
mod publication_record; // runtime_package_startup.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_gpu.rs"]
mod deep2d_gpu; // deep2d_gpu.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_atlas_gpu.rs"]
mod deep2d_atlas_gpu; // deep2d_atlas_gpu.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_gpu_cache.rs"]
mod deep2d_gpu_cache; // deep2d_gpu_cache.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_scissor.rs"]
mod deep2d_scissor; // deep2d_scissor.rs 被 player_picking/publication_verification 等引用
#[path = "../src/dashboard_video_gpu.rs"]
mod dashboard_video_gpu; // dashboard_video_gpu.rs 被 player_picking/publication_verification 等引用
#[path = "../src/gpu_resources.rs"]
mod gpu_resources; // gpu_resources.rs 被 player_picking/publication_verification 等引用
#[path = "../src/shadow_map/mod.rs"]
mod shadow_map; // shadow_map.rs 被 player_picking/publication_verification 等引用


use deep_engine_native::chart::{
    ChartAction, ChartDataUpdate, ChartEpoch, ChartEpochCommit, ChartRuntime, parse_chart_ir,
};
use deep_engine_native::deep2d::Deep2dRuntimeContent;
use player_content::PlayerContent;
use serde_json::json;

fn runtime() -> ChartRuntime {
    let ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ChartRuntime::new(ir, 640.0, 360.0).unwrap()
}

fn display_list(chart: &ChartRuntime, page: usize) -> Deep2dRuntimeContent {
    let mut rasterizer = deep_engine_native::platform_text::TextRasterizer::new();
    let list = deep_engine_native::chart::presentation::present_chart(
        chart,
        &mut rasterizer,
        page,
        [0.0, 0.0],
        None,
    )
    .unwrap();
    Deep2dRuntimeContent::DisplayList(list)
}

fn replace_main(rows: Vec<Vec<serde_json::Value>>) -> deep_engine_native::chart::DatasetRowsUpdate {
    deep_engine_native::chart::DatasetRowsUpdate::Replace {
        dataset_id: "main".into(),
        rows,
    }
}

fn rows() -> Vec<Vec<serde_json::Value>> {
    vec![vec![json!("C"), json!(4), json!(0.4), json!("新设备")]]
}

fn package(bytes: &[u8]) -> PlayerContent {
    PlayerContent::from_package(
        deep_engine_native::runtime_package::parse_and_validate_runtime_package(bytes).unwrap(),
    )
    .unwrap()
}

#[test]
fn data_update_advances_epoch_and_chart_from_one_source() {
    let mut chart = runtime();
    let epoch = ChartEpoch::initial();
    chart
        .update_data(ChartDataUpdate {
            expected_data_revision: 0,
            data_revision: 1,
            datasets: vec![replace_main(rows())],
        })
        .unwrap();
    let snapshot = epoch.current_epoch(Some(&chart));
    assert_eq!(snapshot.data_revision, 1);
    assert_eq!(snapshot.data_revision, chart.data_revision());
    assert!(!snapshot.published);
}

#[test]
fn failed_data_or_present_keeps_epoch_and_content_stale() {
    let mut chart = runtime();
    let epoch = ChartEpoch::initial();
    let before = chart.clone();
    // 数据更新失败(stale CAS):runtime 零写入,epoch 同源读数保持旧值。
    assert!(
        chart
            .update_data(ChartDataUpdate {
                expected_data_revision: 99,
                data_revision: 1,
                datasets: vec![replace_main(rows())],
            })
            .is_err()
    );
    // 非法批次同样失败。
    assert!(
        chart
            .update_data(ChartDataUpdate {
                expected_data_revision: 0,
                data_revision: 1,
                datasets: Vec::new(),
            })
            .is_err()
    );
    // 呈现失败等价:候选事务构建后未 commit 即丢弃,epoch 与内容全部保持旧值。
    let rejected = ChartEpochCommit::new(chart.clone(), display_list(&chart, 0), 0);
    drop(rejected);
    let snapshot = epoch.current_epoch(Some(&chart));
    assert_eq!(snapshot, ChartEpoch::initial());
    assert!(std::ptr::eq(before.frame(), chart.frame()));
    assert_eq!(before.state(), chart.state());
    assert_eq!(before.source(), chart.source());
}

#[test]
fn interaction_commit_advances_published_without_touching_data_revision() {
    let mut chart = runtime();
    let mut epoch = ChartEpoch::initial();
    let revision_before = chart.revision();
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "bar".into(),
        })
        .unwrap();
    assert!(chart.revision() > revision_before);
    assert_eq!(epoch.current_epoch(Some(&chart)).data_revision, 0);
    assert!(!epoch.published);
    let (landed, _) =
        ChartEpochCommit::new(chart.clone(), display_list(&chart, 0), 0).commit(&mut epoch);
    assert!(epoch.published);
    assert!(std::ptr::eq(landed.frame(), chart.frame()));
    assert_eq!(landed.revision(), chart.revision());
}

#[test]
fn legend_page_commit_advances_resource_set_only() {
    let chart = runtime();
    let mut epoch = ChartEpoch::initial();
    let (revision, data) = (chart.revision(), chart.data_revision());
    // legend 页变更:旧 chart + 新 page 呈现,chart 状态不动,仅 resource_set/published 推进。
    let (landed, _) =
        ChartEpochCommit::new(chart.clone(), display_list(&chart, 2), 2).commit(&mut epoch);
    assert_eq!(epoch.resource_set, 2);
    assert!(epoch.published);
    assert_eq!(landed.revision(), revision);
    assert_eq!(landed.data_revision(), data);
    assert_eq!(epoch.current_epoch(Some(&landed)).data_revision, data);
}

#[test]
fn package_reload_rebuilds_document_epoch() {
    let open = |bytes| package(bytes);
    let a = open(include_bytes!("fixtures/runtime-package-camera-v3.json"));
    let again = open(include_bytes!("fixtures/runtime-package-camera-v3.json"));
    assert_ne!(a.epoch.document_revision, 0);
    assert_eq!(a.epoch.document_revision, again.epoch.document_revision);
    let b = open(include_bytes!(
        "fixtures/runtime-package-camera-v3-coordinates.json"
    ));
    assert_ne!(a.epoch.document_revision, b.epoch.document_revision);
    assert_eq!(b.epoch.current_epoch(b.chart.as_ref()).data_revision, 0);
    // 无包来源以 chart id 为文档标识,换源同样重建 epoch。
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    let by_chart = PlayerContent::from_chart(ir.clone()).unwrap();
    assert_eq!(
        by_chart.epoch.document_revision,
        ChartEpoch::document_revision(&by_chart.chart.as_ref().unwrap().source().id, "chart")
    );
    ir.id = "another-chart".into();
    let other = PlayerContent::from_chart(ir).unwrap();
    assert_ne!(
        by_chart.epoch.document_revision,
        other.epoch.document_revision
    );
}

#[test]
fn published_flips_only_through_commit() {
    let chart = runtime();
    let mut epoch = ChartEpoch::for_document(7);
    assert_eq!(epoch.document_revision, 7);
    let pending = ChartEpochCommit::new(chart.clone(), display_list(&chart, 0), 0);
    assert!(!epoch.published, "候选构建不得改写 published");
    drop(pending);
    let content = display_list(&chart, 0);
    let _ = ChartEpochCommit::new(chart, content, 0).commit(&mut epoch);
    assert!(epoch.published);
}

#[test]
fn layout_bump_advances_layout_revision_without_other_dimensions() {
    let mut epoch = ChartEpoch::for_document(3);
    assert_eq!(epoch.layout_revision, 0);
    assert_eq!(epoch.bump_layout().unwrap(), 1);
    assert_eq!(epoch.bump_layout().unwrap(), 2);
    assert_eq!(epoch.document_revision, 3);
    assert!(!epoch.published);
    assert_eq!(epoch.resource_set, 0);
}
