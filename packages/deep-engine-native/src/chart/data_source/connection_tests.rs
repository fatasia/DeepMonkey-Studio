use super::*;

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
