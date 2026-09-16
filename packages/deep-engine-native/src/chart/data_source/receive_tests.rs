use super::*;

#[test]
fn connect_receive_advances_committed_version() {
    let mut machine = DataSourceMachine::new(
        config(8),
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    assert_eq!(*machine.state(), DataSourceState::Disconnected);
    machine.connect(T0).unwrap();
    assert_eq!(*machine.state(), DataSourceState::Connected);
    assert_eq!(machine.committed_source_version(), None); // 版本序列允许从 0 起
    let first = delivered(&mut machine, SOURCE_ID, 0);
    delivered(&mut machine, SOURCE_ID, 5);
    assert_eq!(machine.committed_source_version(), Some(5));
    assert_eq!(machine.cache_len(), 2);
    assert_eq!(first.bytes, update_bytes(0)); // 交付负载与缓存内容一致
}

#[test]
fn stale_and_duplicate_versions_dropped_without_callback() {
    let mut machine = DataSourceMachine::new(
        config(8),
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    machine.connect(T0).unwrap();
    delivered(&mut machine, SOURCE_ID, 7);
    assert_eq!(
        machine.on_receive(payload(SOURCE_ID, 6)),
        ReceiveVerdict::DroppedStaleVersion
    );
    assert_eq!(
        machine.on_receive(payload(SOURCE_ID, 7)),
        ReceiveVerdict::DroppedStaleVersion
    ); // 重复同样丢弃
    assert_eq!(machine.committed_source_version(), Some(7));
    assert_eq!(machine.cache_len(), 1);
    assert_eq!(machine.counters().stale_dropped, 2);
    let newer = machine.on_receive(payload(SOURCE_ID, 9)); // 跳版接受:不猜源端是否有洞
    assert!(matches!(newer, ReceiveVerdict::Delivered(_)));
    assert_eq!(machine.committed_source_version(), Some(9));
    assert_eq!(machine.cache_len(), 2);
}

#[test]
fn cache_is_bounded_ring_with_eviction_count_and_watermark_replay() {
    let mut machine = DataSourceMachine::new(
        config(4),
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    machine.connect(T0).unwrap();
    for version in 1..=10 {
        delivered(&mut machine, SOURCE_ID, version);
    }
    assert_eq!(machine.cache_len(), 4);
    assert_eq!(machine.counters().cache_evicted, 6);
    let pending = machine.cache_pending_after(7); // 宿主确认消化到 v7 → 应续传 v8..v10
    assert_eq!(
        pending
            .iter()
            .map(|payload| payload.source_version)
            .collect::<Vec<_>>(),
        vec![8, 9, 10]
    );
    assert_eq!(pending[0].bytes, update_bytes(0));
    assert!(machine.cache_pending_after(10).is_empty()); // 水位追平 → 无待续传
    // 断连不影响缓存;恢复后对接点仍然可查
    machine.on_error("drop", T0 + 1).unwrap();
    assert_eq!(machine.cache_pending_after(7).len(), 3);
}

#[test]
fn wrong_source_payload_rejected_and_counted() {
    let mut machine = DataSourceMachine::new(
        config(4),
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    machine.connect(T0).unwrap();
    delivered(&mut machine, SOURCE_ID, 3);
    // 串源检查优先于版本检查:异源旧版本也按串源拒绝,不污染本源版本历史
    assert_eq!(
        machine.on_receive(payload("telemetry-other", 1)),
        ReceiveVerdict::DroppedWrongSource
    );
    // 串源负载不得推进版本、不得入缓存
    assert_eq!(machine.committed_source_version(), Some(3));
    assert_eq!(machine.cache_len(), 1);
    assert_eq!(machine.counters().wrong_source, 1);
    // 非连接态收到数据:丢弃并计数(与串源分开计)
    machine.on_error("drop", T0 + 1).unwrap();
    assert_eq!(
        machine.on_receive(payload(SOURCE_ID, 4)),
        ReceiveVerdict::DroppedOffline
    );
    assert_eq!(machine.counters().offline_receive_dropped, 1);
}

#[test]
fn cache_byte_budget_evicts_oldest_even_when_capacity_allows() {
    let mut machine = DataSourceMachine::new(
        DataSourceConfig {
            cache_byte_budget: 4_000,
            ..config(64)
        },
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    machine.connect(T0).unwrap();
    let per_payload = update_bytes(0).len() + SOURCE_ID.len();
    // 装满预算:条数远未到 64,淘汰却已经开始。
    let fits = 4_000 / per_payload;
    for version in 1..=(fits as u64 + 3) {
        delivered(&mut machine, SOURCE_ID, version);
    }
    assert!(machine.cache_len() <= 64, "条数上限未被突破");
    assert!(
        machine.cache_bytes() <= 4_000,
        "字节预算必须被守住,实际 {}",
        machine.cache_bytes()
    );
    assert!(
        machine.counters().cache_evicted >= 3,
        "字节触顶必须产生淘汰,实际 {}",
        machine.counters().cache_evicted
    );
    assert_eq!(machine.counters().cache_oversized, 0, "单条未超预算");
    // 续传仍从 watermark 之后取,语义不受淘汰口径影响。
    let watermark = machine
        .cache_pending_after(0)
        .first()
        .map(|p| p.source_version - 1)
        .unwrap_or(0);
    let pending = machine.cache_pending_after(watermark);
    assert!(pending.iter().all(|p| p.source_version > watermark));
}

#[test]
fn oversized_payload_is_delivered_but_never_cached() {
    let mut machine = DataSourceMachine::new(
        DataSourceConfig {
            cache_byte_budget: 512,
            ..config(64)
        },
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    machine.connect(T0).unwrap();
    delivered(&mut machine, SOURCE_ID, 1);
    let before_len = machine.cache_len();
    let before_bytes = machine.cache_bytes();

    let huge = DataSourcePayload {
        source_id: SOURCE_ID.into(),
        source_version: 2,
        bytes: vec![0u8; 4_096],
    };
    match machine.on_receive(huge) {
        ReceiveVerdict::Delivered(payload) => assert_eq!(payload.source_version, 2),
        verdict => panic!("oversized payload must still be delivered, got {verdict:?}"),
    }
    assert_eq!(machine.counters().cache_oversized, 1);
    assert_eq!(machine.cache_len(), before_len, "既有缓存不得被清空");
    assert_eq!(machine.cache_bytes(), before_bytes, "字节账不得被污染");
    assert_eq!(machine.committed_source_version(), Some(2), "版本仍推进");
}
