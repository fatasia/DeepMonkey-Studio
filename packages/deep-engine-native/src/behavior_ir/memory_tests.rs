use super::*;

#[test]
fn duplicate_idempotency_key_is_rejected_without_second_reservation() {
    let mut bus = bus();
    submit(&mut bus, "same-key-1", set_visible("a", true), 0).unwrap();
    let second = submit(&mut bus, "same-key-1", set_visible("b", true), 10);
    assert_eq!(
        second,
        Err(SubmitRejection::DuplicateIdempotencyKey {
            key: "same-key-1".into()
        })
    );
    assert_eq!(bus.in_flight_len(), 1, "不得为重复键建立第二个在途");
    assert_eq!(bus.counters().rejected_duplicate_idempotency, 1);
}

#[test]
fn cancelled_commands_never_apply_and_are_distinguishable() {
    let mut bus = bus();
    let invocation = submit(&mut bus, "key-0005", set_visible("a", true), 0).unwrap();
    assert_eq!(
        bus.cancel(invocation),
        CancelOutcome::Cancelled { invocation }
    );
    // 与「从未提交」区分:已取消返回 Cancelled,不是 NotInFlight。
    assert_eq!(
        bus.settle(invocation),
        Err(SettleRejection::Cancelled { invocation })
    );
    assert!(bus.target().applied.is_empty(), "取消的命令不得应用");
    assert_eq!(bus.revision(), BehaviorRevision(0), "取消不得推进 revision");
    // 取消是幂等的:重复取消返回 NotInFlight 而不是错误。
    assert_eq!(
        bus.cancel(invocation),
        CancelOutcome::NotInFlight { invocation }
    );
    assert_eq!(bus.counters().cancelled, 1);
    assert_eq!(bus.counters().cancel_missed, 1);
}

#[test]
fn cancel_releases_in_flight_budget() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_in_flight: 1,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    let first = submit(&mut bus, "key-0006", set_visible("a", true), 0).unwrap();
    assert_eq!(
        submit(&mut bus, "key-0007", set_visible("b", true), 0),
        Err(SubmitRejection::InFlightBudgetExceeded {
            in_flight: 1,
            max: 1
        })
    );
    bus.cancel(first);
    submit(&mut bus, "key-0008", set_visible("c", true), 0).expect("取消后额度应被释放");
}

#[test]
fn cancel_all_voids_every_in_flight_command() {
    let mut bus = bus();
    let first = submit(&mut bus, "key-0009", set_visible("a", true), 0).unwrap();
    let second = submit(&mut bus, "key-0010", set_visible("b", true), 0).unwrap();
    assert_eq!(bus.cancel_all(), vec![first, second]);
    assert_eq!(bus.in_flight_len(), 0);
    assert!(matches!(
        bus.settle(first),
        Err(SettleRejection::Cancelled { .. })
    ));
    assert!(matches!(
        bus.settle(second),
        Err(SettleRejection::Cancelled { .. })
    ));
    assert!(bus.target().applied.is_empty());
}

#[test]
fn idempotency_memory_is_bounded_and_lossy_by_design() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_idempotency_keys: 2,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    for (index, key) in ["key-a-0001", "key-b-0002", "key-c-0003"]
        .iter()
        .enumerate()
    {
        submit(&mut bus, key, set_visible("a", true), index as u64).unwrap();
    }
    assert_eq!(
        bus.counters().idempotency_forgotten,
        1,
        "容量 2 装 3 键必须遗忘 1 个"
    );
    // 被遗忘的键可再次提交:有损记忆的必然结果,计数已如实暴露。
    submit(&mut bus, "key-a-0001", set_visible("b", true), 9).expect("被遗忘的键可再次使用");
}

#[test]
fn idempotency_memory_evicts_in_submission_order() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_idempotency_keys: 2,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    for key in ["z-key-001", "a-key-002", "m-key-003"] {
        submit(&mut bus, key, set_visible("a", true), 0).unwrap();
    }
    assert!(matches!(
        submit(&mut bus, "a-key-002", set_visible("a", true), 0),
        Err(SubmitRejection::DuplicateIdempotencyKey { .. })
    ));
    submit(&mut bus, "z-key-001", set_visible("a", true), 0).unwrap();
}

#[test]
fn cancellation_memory_evicts_in_cancellation_order() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_cancelled_memory: 2,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    let ids = [9, 2, 6].map(InvocationId);
    for (index, id) in ids.iter().enumerate() {
        let cmd = command_at(
            *id,
            bus.revision(),
            &format!("key-{index:04}"),
            set_visible("a", true),
        );
        bus.submit(cmd, 0).unwrap();
        bus.cancel(*id);
    }
    assert_eq!(
        bus.settle(ids[0]),
        Err(SettleRejection::NotInFlight { invocation: ids[0] })
    );
    for id in &ids[1..] {
        assert_eq!(
            bus.settle(*id),
            Err(SettleRejection::Cancelled { invocation: *id })
        );
    }
}

#[test]
fn cancelled_invocation_cannot_be_resubmitted() {
    let mut bus = bus();
    let id = submit(&mut bus, "key-first", set_visible("a", true), 0).unwrap();
    bus.cancel(id);
    let cmd = command_at(id, bus.revision(), "key-reuse", set_visible("b", true));
    assert_eq!(
        bus.submit(cmd, 0),
        Err(SubmitRejection::DuplicateInvocation { invocation: id })
    );
    assert_eq!(bus.in_flight_len(), 0);
}

#[test]
fn zero_memory_budgets_forget_immediately() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_idempotency_keys: 0,
            max_cancelled_memory: 0,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    for _ in 0..3 {
        let id = submit(&mut bus, "same-key", set_visible("a", true), 0).unwrap();
        bus.cancel(id);
        assert_eq!(
            bus.settle(id),
            Err(SettleRejection::NotInFlight { invocation: id })
        );
    }
    assert_eq!(bus.counters().idempotency_forgotten, 3);
    assert_eq!(bus.counters().cancel_memory_forgotten, 3);
}

#[test]
fn cancel_all_preserves_recent_batch_and_matching_counters() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_cancelled_memory: 2,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    let old = command_at(
        InvocationId(99),
        bus.revision(),
        "key-old-1",
        set_visible("a", true),
    );
    let old_id = bus.submit(old, 0).unwrap();
    bus.cancel(old_id);
    let first = submit(&mut bus, "key-new-1", set_visible("a", true), 0).unwrap();
    let second = submit(&mut bus, "key-new-2", set_visible("b", true), 0).unwrap();
    assert_eq!(bus.cancel_all(), vec![first, second]);
    assert_eq!(
        bus.settle(old_id),
        Err(SettleRejection::NotInFlight { invocation: old_id })
    );
    for id in [first, second] {
        assert_eq!(
            bus.settle(id),
            Err(SettleRejection::Cancelled { invocation: id })
        );
    }
    assert!(bus.cancel_all().is_empty());
    assert_eq!(bus.counters().cancel_requested, 3);
    assert_eq!(bus.counters().cancelled, 3);
    assert_eq!(bus.counters().cancel_memory_forgotten, 1);
}
