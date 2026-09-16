//! P1-13 第一批:数据源状态机,全部固定时钟与脚本 Transport,无真实等待。
use super::{
    DataSourceConfig, DataSourceMachine, DataSourcePayload, DataSourceState, ReceiveVerdict,
    Transport, TransportFailure, TransportOutcome, payload_to_chart_message,
};
use crate::chart::{ChartRuntime, parse_chart_ir};
use serde_json::json;
use std::collections::VecDeque;

const SOURCE_ID: &str = "telemetry-main";
const T0: u64 = 1_000;

/// 固定脚本 Mock:connect/send 逐次弹出脚本结果,脚本耗尽即测试缺陷,直接 panic。
/// close 只增计数不清空状态,便于断言「关闭且仅关闭一次」。
struct ScriptedTransport {
    connect_script: VecDeque<TransportOutcome>,
    send_script: VecDeque<TransportOutcome>,
    sent: Vec<Vec<u8>>,
    close_count: usize,
}

impl ScriptedTransport {
    fn new(connect: Vec<TransportOutcome>) -> Self {
        Self {
            connect_script: connect.into(),
            send_script: VecDeque::new(),
            sent: Vec::new(),
            close_count: 0,
        }
    }
    fn with_sends(connect: Vec<TransportOutcome>, send: Vec<TransportOutcome>) -> Self {
        Self {
            connect_script: connect.into(),
            send_script: send.into(),
            sent: Vec::new(),
            close_count: 0,
        }
    }
    fn pop(script: &mut VecDeque<TransportOutcome>) -> TransportOutcome {
        script.pop_front().expect("transport script exhausted")
    }
}

impl Transport for ScriptedTransport {
    fn connect(&mut self) -> TransportOutcome {
        Self::pop(&mut self.connect_script)
    }
    fn send(&mut self, bytes: &[u8]) -> TransportOutcome {
        self.sent.push(bytes.to_vec());
        Self::pop(&mut self.send_script)
    }
    fn close(&mut self) {
        self.close_count += 1;
    }
}

fn config(capacity: usize) -> DataSourceConfig {
    DataSourceConfig {
        source_id: SOURCE_ID.into(),
        cache_capacity: capacity,
        // 0 = 不设字节预算/不设 deadline,保持既有用例的行为面不变。
        cache_byte_budget: 0,
        idle_deadline_ms: 0,
        backoff_base_ms: 4,
        backoff_max_ms: 64,
    }
}

fn payload(source_id: &str, version: u64) -> DataSourcePayload {
    DataSourcePayload {
        source_id: source_id.into(),
        source_version: version,
        bytes: update_bytes(0),
    }
}

/// 合法 chart-data-update 负载;`base_revision` 故意写死,证明适配时会被 CAS 重写。
fn update_bytes(base_revision: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "schema": "deep-engine.chart-data-update", "schemaVersion": 1,
        "chartId": "chart-v1-golden",
        "expectedDataRevision": base_revision, "dataRevision": base_revision + 1,
        "datasets": [{ "kind": "append-window", "datasetId": "main",
            "rows": [["D", 4, 0.4, "水箱四"]], "maxRows": 3 }]
    }))
    .unwrap()
}

fn delivered(
    machine: &mut DataSourceMachine<ScriptedTransport>,
    source_id: &str,
    version: u64,
) -> DataSourcePayload {
    match machine.on_receive(payload(source_id, version)) {
        ReceiveVerdict::Delivered(payload) => payload,
        verdict => panic!("expected delivery of v{version}, got {verdict:?}"),
    }
}

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
fn connect_failure_backs_off_exponentially_then_recovers() {
    let transport = ScriptedTransport::new(vec![
        TransportOutcome::Down(TransportFailure::Unavailable("conn refused".into())),
        TransportOutcome::Down(TransportFailure::Timeout),
        TransportOutcome::Up,
    ]);
    let mut machine = DataSourceMachine::new(config(4), transport).unwrap();
    // 首败:attempt=1,due = T0 + base(4ms)
    assert_eq!(
        machine.connect(T0).unwrap_err(),
        "data source connect unavailable: conn refused"
    );
    assert_eq!(
        *machine.state(),
        DataSourceState::Retrying {
            attempt: 1,
            due_ms: T0 + 4
        }
    );
    assert_eq!(
        machine.connect(T0 + 3).unwrap_err(),
        "retry backoff pending until 1004 ms"
    );
    assert!(!machine.poll_retry(T0 + 3)); // 退避未到期不得发起
    // 二败:到期即发起,poll_retry 只报告「发起了尝试」,结果看状态
    assert!(machine.poll_retry(T0 + 4));
    assert_eq!(
        *machine.state(),
        DataSourceState::Retrying {
            attempt: 2,
            due_ms: T0 + 12
        }
    ); // 指数翻倍 4→8
    assert_eq!(machine.counters().retries_scheduled, 2);
    // 三连:到期恢复 Connected
    assert!(machine.poll_retry(T0 + 12));
    assert_eq!(*machine.state(), DataSourceState::Connected);
    delivered(&mut machine, SOURCE_ID, 1); // 恢复后可继续收数
}

#[test]
fn error_while_connected_closes_transport_and_retry_recover_path_works() {
    let transport = ScriptedTransport::new(vec![
        TransportOutcome::Up,
        TransportOutcome::Down(TransportFailure::Timeout),
        TransportOutcome::Up,
    ]);
    let mut machine = DataSourceMachine::new(config(4), transport).unwrap();
    machine.connect(T0).unwrap();
    machine.on_error("reset by peer", T0 + 1).unwrap();
    assert_eq!(
        *machine.state(),
        DataSourceState::Retrying {
            attempt: 1,
            due_ms: T0 + 5
        }
    );
    assert_eq!(machine.last_failure(), Some("reset by peer")); // 失败原因可诊断
    assert_eq!(machine.transport.close_count, 1); // on_error 必须关闭在途连接
    // 连续失败 attempt 累计:二败退避 4→8ms,due = 1005 + 8
    assert_eq!(
        machine.connect(T0 + 5).unwrap_err(),
        "data source connect timed out"
    );
    assert_eq!(
        *machine.state(),
        DataSourceState::Retrying {
            attempt: 2,
            due_ms: T0 + 13
        }
    );
    // 无在途连接时的 timeout/error 是宿主调度错误,显式报错不静默(Retrying 等待期无在途连接)
    assert_eq!(
        machine.on_timeout(T0 + 6).unwrap_err(),
        "no connection attempt in flight"
    );
    assert_eq!(
        machine.on_error("late", T0 + 6).unwrap_err(),
        "no connection to fail"
    );
    assert_eq!(machine.transport.close_count, 1);
    assert!(machine.poll_retry(T0 + 13));
    assert_eq!(*machine.state(), DataSourceState::Connected); // 成功连接后 attempt 归零(下次掉线从 1 重计)
}

#[test]
fn timeout_while_connected_schedules_retry() {
    let transport = ScriptedTransport::new(vec![
        TransportOutcome::Up,
        TransportOutcome::Down(TransportFailure::Timeout),
    ]);
    let mut machine = DataSourceMachine::new(config(4), transport).unwrap();
    machine.connect(T0).unwrap();
    machine.on_timeout(T0 + 30).unwrap();
    assert_eq!(
        *machine.state(),
        DataSourceState::Retrying {
            attempt: 1,
            due_ms: T0 + 34
        }
    );
    assert_eq!(machine.transport.close_count, 1);
    assert_eq!(
        machine.connect(T0 + 30).unwrap_err(),
        "retry backoff pending until 1034 ms"
    );
    // 到期重试再次超时:连续失败退避继续翻倍 4→8ms,due = 1034 + 8
    assert!(machine.poll_retry(T0 + 34));
    assert_eq!(
        *machine.state(),
        DataSourceState::Retrying {
            attempt: 2,
            due_ms: T0 + 42
        }
    );
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
fn cancel_is_terminal_idempotent_and_rejects_everything() {
    let mut machine = DataSourceMachine::new(
        config(4),
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    machine.connect(T0).unwrap();
    machine.cancel();
    assert_eq!(*machine.state(), DataSourceState::Closed);
    machine.cancel(); // 重复取消幂等:不再触碰 transport
    assert_eq!(*machine.state(), DataSourceState::Closed);
    assert_eq!(machine.transport.close_count, 1);
    assert_eq!(
        machine.on_receive(payload(SOURCE_ID, 1)),
        ReceiveVerdict::RejectedClosed
    );
    assert_eq!(machine.connect(T0 + 1).unwrap_err(), "data source closed");
    assert_eq!(
        machine.on_timeout(T0 + 1).unwrap_err(),
        "data source closed"
    );
    assert_eq!(
        machine.on_error("late", T0 + 1).unwrap_err(),
        "data source closed"
    );
    assert_eq!(
        machine.send(b"{}", T0 + 1).unwrap_err(),
        "data source send rejected in state Closed"
    );
    assert_eq!(machine.counters().send_rejected, 1);
    assert_eq!(machine.transport.close_count, 1);
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
fn send_flows_when_connected_and_failure_drops_into_retry() {
    let transport = ScriptedTransport::with_sends(
        vec![TransportOutcome::Up, TransportOutcome::Up],
        vec![
            TransportOutcome::Up,
            TransportOutcome::Down(TransportFailure::Timeout),
        ],
    );
    let mut machine = DataSourceMachine::new(config(4), transport).unwrap();
    assert_eq!(
        machine.send(b"{}", T0).unwrap_err(),
        "data source send rejected in state Disconnected"
    );
    assert_eq!(machine.counters().send_rejected, 1);
    machine.connect(T0).unwrap();
    machine.send(b"ping", T0 + 1).unwrap();
    assert_eq!(
        machine.send(b"{}", T0 + 3).unwrap_err(),
        "data source send timed out"
    );
    assert_eq!(
        *machine.state(),
        DataSourceState::Retrying {
            attempt: 1,
            due_ms: T0 + 7
        }
    );
    assert_eq!(machine.transport.close_count, 1); // send 失败同样关闭在途连接
    assert!(machine.poll_retry(T0 + 7)); // 第二个 Up 脚本:恢复
    assert_eq!(*machine.state(), DataSourceState::Connected);
    assert_eq!(
        machine.transport.sent,
        vec![b"ping".to_vec(), b"{}".to_vec()]
    );
}

#[test]
fn payload_adapts_to_chart_message_and_cas_applies_to_runtime() {
    let mut chart = ChartRuntime::new(
        parse_chart_ir(include_bytes!(
            "../../../deep-engine/fixtures/chart-ir-v1.json"
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

// ---- P1-13 剩余:缓存字节预算与宿主 deadline ----

/// 字节预算必须与条数上限共同生效:容量给足但字节先触顶时,按字节淘汰最旧。
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

/// 单条自身超预算:整条不入缓存(仍交付),不得为它清空已有缓存。
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

/// 宿主静默窗口:连接建立后长期无活动,必须自动收口进入可重试状态。
///
/// 同步 Transport 下 `connect()` 立即返回,不存在可观察的握手驻留,因此本窗口
/// 覆盖的是连接建立后的静默期——那正是最需要探测的死链形态。
#[test]
fn idle_window_closes_a_silent_connection_and_schedules_retry() {
    let mut machine = DataSourceMachine::new(
        DataSourceConfig {
            idle_deadline_ms: 250,
            ..config(8)
        },
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    assert_eq!(machine.idle_deadline(), None, "未连接时无静默窗口");
    machine.connect(T0).unwrap();
    // 连接建立即起算:窗口 = 最后活动 + 250ms。
    assert_eq!(machine.idle_deadline(), Some(T0 + 250));
    assert!(!machine.poll_idle_deadline(T0 + 249), "未到期不得收口");
    assert_eq!(machine.state(), &DataSourceState::Connected, "未到期仍连接");

    // 无时间戳重载不刷新窗口;带时间戳接收会顺延到期时刻。
    delivered(&mut machine, SOURCE_ID, 1);
    assert_eq!(
        machine.idle_deadline(),
        Some(T0 + 250),
        "无时间戳重载不刷新窗口"
    );
    machine.on_receive_at(payload(SOURCE_ID, 2), T0 + 100);
    assert_eq!(machine.idle_deadline(), Some(T0 + 350), "带时间戳接收刷新窗口");

    // 到期收口:关连接 + 退避,并记一条 idle 账。
    assert!(machine.poll_idle_deadline(T0 + 350));
    assert!(matches!(machine.state(), DataSourceState::Retrying { .. }));
    assert_eq!(machine.counters().idle_timeouts, 1);
    assert_eq!(machine.idle_deadline(), None, "退避中无静默窗口");
    // 幂等:不在连接态时重复调用不重复记账。
    assert!(!machine.poll_idle_deadline(T0 + 10_000));
    assert_eq!(machine.counters().idle_timeouts, 1);
}

/// 静默窗口必须尊重终态:取消后不再收口,也不得制造重试。
#[test]
fn idle_window_respects_terminal_close_and_cancel() {
    let mut machine = DataSourceMachine::new(
        DataSourceConfig {
            idle_deadline_ms: 100,
            ..config(8)
        },
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    machine.connect(T0).unwrap();
    let due = machine.idle_deadline().expect("连接态有窗口");
    machine.cancel();
    assert_eq!(machine.state(), &DataSourceState::Closed);
    assert_eq!(machine.idle_deadline(), None, "取消清理窗口");
    assert!(!machine.poll_idle_deadline(due + 1), "终态后不再收口");
    assert_eq!(machine.counters().idle_timeouts, 0);
    assert_eq!(machine.counters().retries_scheduled, 0, "不得制造重试");
}

/// 未设窗口(0)时静默检测是彻底的空操作:不得改变第一批的既有行为。
#[test]
fn unset_idle_window_is_a_noop() {
    let mut machine = DataSourceMachine::new(
        config(8),
        ScriptedTransport::new(vec![TransportOutcome::Up]),
    )
    .unwrap();
    machine.connect(T0).unwrap();
    assert_eq!(machine.idle_deadline(), None);
    assert!(!machine.poll_idle_deadline(T0 + 86_400_000));
    assert_eq!(machine.state(), &DataSourceState::Connected);
    assert_eq!(machine.counters().idle_timeouts, 0);
}

/// 配置边界:字节预算与静默窗口越界必须在构造期被拒。
#[test]
fn config_rejects_out_of_bounds_budget_and_idle_window() {
    let with = |budget: usize, idle: u64| DataSourceConfig {
        cache_byte_budget: budget,
        idle_deadline_ms: idle,
        ..config(8)
    };
    assert!(with(0, 0).validated().is_ok(), "0 = 不设约束");
    assert!(with(DataSourceConfig::MAX_CACHE_BYTE_BUDGET, 0).validated().is_ok());
    assert!(
        with(DataSourceConfig::MAX_CACHE_BYTE_BUDGET + 1, 0)
            .validated()
            .is_err()
    );
    assert!(with(0, DataSourceConfig::MAX_IDLE_DEADLINE_MS).validated().is_ok());
    assert!(
        with(0, DataSourceConfig::MAX_IDLE_DEADLINE_MS + 1)
            .validated()
            .is_err()
    );
}
