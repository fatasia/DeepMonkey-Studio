use super::*;

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
    assert_eq!(
        machine.idle_deadline(),
        Some(T0 + 350),
        "带时间戳接收刷新窗口"
    );

    // 到期收口:关连接 + 退避,并记一条 idle 账。
    assert!(machine.poll_idle_deadline(T0 + 350));
    assert!(matches!(machine.state(), DataSourceState::Retrying { .. }));
    assert_eq!(machine.counters().idle_timeouts, 1);
    assert_eq!(machine.idle_deadline(), None, "退避中无静默窗口");
    // 幂等:不在连接态时重复调用不重复记账。
    assert!(!machine.poll_idle_deadline(T0 + 10_000));
    assert_eq!(machine.counters().idle_timeouts, 1);
}

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
