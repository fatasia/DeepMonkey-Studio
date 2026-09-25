//! B5 多选过滤测试:单选兼容、多选切换与交集、非法索引 fail-closed。
use super::*;

/// 多选夹具:在单选夹具上开启 `multiSelect`,并把 option1 改为 option0 数据集
/// 首行的单行子集,使交集语义可以直接按行数断言。
fn multi_fixture() -> LoadedDashboard {
    let mut loaded = super::filter_tests::fixture();
    let filter = loaded.document.filter.as_mut().unwrap();
    filter.multi_select = true;
    let first = filter.options[0].updates[0].datasets[0]
        .rows
        .iter()
        .next()
        .cloned()
        .expect("fixture chart must have rows");
    filter.options[1].updates[0].datasets[0].rows = crate::chart::ChartRows::from(vec![first]);
    loaded
}

#[test]
fn single_select_package_stays_untouched_by_multi_select_state() {
    // 旧冻结包没有 multiSelect 字段:serde default 关闭多选,序列化时省略,双端兼容。
    let parse = |value: serde_json::Value| {
        serde_json::from_value::<crate::runtime_package::DashboardFrozenFilter>(value)
            .expect("frozen filter must parse")
    };
    assert!(
        !parse(serde_json::json!({
            "nodeId": "n", "sourceNodeId": "s", "key": "k", "options": []
        }))
        .multi_select
    );
    assert!(
        parse(serde_json::json!({
            "nodeId": "n", "sourceNodeId": "s", "key": "k", "multiSelect": true, "options": []
        }))
        .multi_select
    );

    let loaded = super::filter_tests::fixture();
    assert!(!loaded.document.filter.as_ref().unwrap().multi_select);
    let mut runtime = DashboardRuntime::new(loaded).unwrap();
    assert!(runtime.selected_options().is_empty());
    assert_eq!(runtime.selected_filter(), Some(0));
    // 单选包拒绝多选切换,避免与 selected_filter 形成双事实源。
    assert!(runtime.toggle_filter_option(0).is_err());
    assert!(runtime.select_filter(1).unwrap());
    assert_eq!(runtime.selected_filter(), Some(1));
    assert!(runtime.select_filter(0).unwrap());
    assert_eq!(runtime.selected_filter(), Some(0));
    // 缺省字段不落盘,旧读取端不受新字段影响。
    let written = serde_json::to_value(runtime.document().filter.as_ref().unwrap()).unwrap();
    assert!(written.get("multiSelect").is_none());
}

#[test]
fn multi_select_toggles_intersect_updates_and_restore_pristine_rows() {
    let mut runtime = DashboardRuntime::new(multi_fixture()).unwrap();
    let target = runtime.document().filter.as_ref().unwrap().options[0].updates[0]
        .node_id
        .clone();
    let pristine = runtime.chart(&target).unwrap().source().datasets.clone();
    // 初始空选集 = 无约束 = 包内原始行。
    assert!(runtime.selected_options().is_empty());
    assert_eq!(runtime.chart(&target).unwrap().source().datasets, pristine);
    // 选 0:option0 冻结的就是原始全量行。
    assert!(runtime.toggle_filter_option(0).unwrap());
    let full = runtime.chart(&target).unwrap().source().datasets.clone();
    assert_eq!(full, pristine);
    // 叠加选 1:交集 = option1 的单行子集,且保持基准行序。
    assert!(runtime.toggle_filter_option(1).unwrap());
    assert_eq!(
        runtime
            .selected_options()
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    let intersected = &runtime.chart(&target).unwrap().source().datasets[0].rows;
    assert_eq!(intersected.len(), 1);
    assert!(intersected.iter().eq(pristine[0].rows.iter().take(1)));
    // 取消 1:回到 option0 全量;全部取消:恢复原始行。
    assert!(runtime.toggle_filter_option(1).unwrap());
    assert_eq!(runtime.chart(&target).unwrap().source().datasets, full);
    assert!(runtime.toggle_filter_option(0).unwrap());
    assert!(runtime.selected_options().is_empty());
    assert_eq!(runtime.chart(&target).unwrap().source().datasets, pristine);
}

#[test]
fn invalid_toggle_index_fails_closed() {
    let mut runtime = DashboardRuntime::new(multi_fixture()).unwrap();
    assert!(runtime.toggle_filter_option(0).unwrap());
    let content = runtime.content.clone();
    let revision = runtime.revision;
    // 越界索引:拒绝且已选集合、版本与合成内容完全不变。
    assert!(runtime.toggle_filter_option(99).is_err());
    assert_eq!(
        runtime
            .selected_options()
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        vec![0]
    );
    assert_eq!(runtime.revision, revision);
    assert!(Arc::ptr_eq(&content, &runtime.content));
    // 无过滤器的运行时同样拒绝(防御性 fail-closed)。
    let mut bare_package = multi_fixture();
    bare_package.document.filter = None;
    let mut bare = DashboardRuntime::new(bare_package).unwrap();
    assert!(bare.toggle_filter_option(0).is_err());
    assert!(bare.selected_options().is_empty());
    // 单选包的越界切换也必须在 multi_select 校验处 fail-closed。
    let mut single = DashboardRuntime::new(super::filter_tests::fixture()).unwrap();
    assert!(single.toggle_filter_option(99).is_err());
}

#[test]
fn pointer_click_on_multi_select_list_toggles_in_one_transaction() {
    // 直接验证指针入口与 toggle 的一致性:同一点击语义,悬停与焦点被同步复位。
    let mut runtime = DashboardRuntime::new(multi_fixture()).unwrap();
    assert!(runtime.toggle_filter_pointer(0, Some(0)).unwrap());
    assert_eq!(
        runtime
            .selected_options()
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        vec![0]
    );
    assert!(runtime.toggle_filter_pointer(0, Some(0)).unwrap());
    assert!(runtime.selected_options().is_empty());
    assert!(runtime.toggle_filter_pointer(7, None).is_err());
}
