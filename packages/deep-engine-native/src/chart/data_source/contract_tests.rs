use super::*;

#[test]
fn config_rejects_invalid_identity_capacity_and_backoff() {
    let base = |source_id: &str, capacity: usize, base_ms: u64, max_ms: u64| DataSourceConfig {
        source_id: source_id.into(),
        cache_capacity: capacity,
        cache_byte_budget: 0,
        idle_deadline_ms: 0,
        backoff_base_ms: base_ms,
        backoff_max_ms: max_ms,
    };
    assert!(base("", 4, 4, 64).validated().is_err()); // 非法 source 身份
    assert!(base(SOURCE_ID, 0, 4, 64).validated().is_err()); // 容量下界
    assert!(base(SOURCE_ID, 65_537, 4, 64).validated().is_err()); // 容量上界
    assert!(base(SOURCE_ID, 4, 64, 4).validated().is_err()); // base > max
    assert!(base(SOURCE_ID, 4, 0, 64).validated().is_err()); // base 为零
}

#[test]
fn config_rejects_out_of_bounds_budget_and_idle_window() {
    let with = |budget: usize, idle: u64| DataSourceConfig {
        cache_byte_budget: budget,
        idle_deadline_ms: idle,
        ..config(8)
    };
    assert!(with(0, 0).validated().is_ok(), "0 = 不设约束");
    assert!(
        with(DataSourceConfig::MAX_CACHE_BYTE_BUDGET, 0)
            .validated()
            .is_ok()
    );
    assert!(
        with(DataSourceConfig::MAX_CACHE_BYTE_BUDGET + 1, 0)
            .validated()
            .is_err()
    );
    assert!(
        with(0, DataSourceConfig::MAX_IDLE_DEADLINE_MS)
            .validated()
            .is_ok()
    );
    assert!(
        with(0, DataSourceConfig::MAX_IDLE_DEADLINE_MS + 1)
            .validated()
            .is_err()
    );
}

#[test]
fn payload_adapts_to_chart_message_and_cas_applies_to_runtime() {
    let mut chart = ChartRuntime::new(
        parse_chart_ir(include_bytes!(
            "../../../../deep-engine/fixtures/chart-ir-v1.json"
        ))
        .unwrap(),
        640.0,
        360.0,
    )
    .unwrap();
    assert_eq!(chart.data_revision(), 0);
    // 源负载里 revision 写死为 41/42,适配必须按 runtime 当前修订重写
    let stale_revision_payload = DataSourcePayload {
        source_id: SOURCE_ID.into(),
        source_version: 1,
        bytes: update_bytes(41),
    };
    let message = payload_to_chart_message(&stale_revision_payload, chart.data_revision()).unwrap();
    assert_eq!(message.expected_data_revision, 0);
    assert_eq!(message.data_revision, 1);
    chart.apply_data_message(message).unwrap();
    assert_eq!(chart.data_revision(), 1);
    // 同一负载在新水位上重新适配仍可应用(断线重连后的重放形态)
    let message = payload_to_chart_message(&stale_revision_payload, chart.data_revision()).unwrap();
    chart.apply_data_message(message).unwrap();
    assert_eq!(chart.data_revision(), 2);
    // 修订顶格:CAS 无法推进,显式报错
    let exhausted = payload_to_chart_message(&stale_revision_payload, 9_007_199_254_740_991);
    assert_eq!(exhausted.unwrap_err(), "chart data revision exhausted");
}
