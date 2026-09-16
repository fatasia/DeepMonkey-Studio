use super::*;

#[test]
fn stale_expected_revision_is_rejected() {
    let mut bus = bus();
    let mut cmd = command(&mut bus, "key-0002", set_visible("a", true));
    cmd.expected_revision = BehaviorRevision(7);
    assert_eq!(
        bus.submit(cmd, 0),
        Err(SubmitRejection::StaleRevision {
            expected: BehaviorRevision(7),
            current: BehaviorRevision(0),
        })
    );
    assert_eq!(bus.counters().rejected_stale_revision, 1);
}

#[test]
fn settle_rejects_when_revision_moved_during_flight() {
    let mut bus = bus();
    let invocation = submit(&mut bus, "key-0003", set_visible("a", true), 0).unwrap();
    // 在途期间宿主状态被推进(另一条命令或外部事件)。
    bus.bump_revision();
    assert_eq!(
        bus.settle(invocation),
        Err(SettleRejection::RevisionMoved {
            expected: BehaviorRevision(0),
            current: BehaviorRevision(1),
        })
    );
    assert!(
        bus.target().applied.is_empty(),
        "CAS 失败的结算不得应用载荷"
    );
    assert_eq!(bus.in_flight_len(), 1, "被拒的结算不移除在途记录");
}

#[test]
fn settle_applies_payload_and_advances_revision() {
    let mut bus = bus();
    let invocation = submit(&mut bus, "key-0004", set_visible("a", true), 0).unwrap();
    assert_eq!(bus.settle(invocation), Ok(BehaviorRevision(1)));
    assert_eq!(bus.target().applied.len(), 1);
    assert_eq!(bus.in_flight_len(), 0);
    assert_eq!(bus.counters().settled, 1);
    // 再次结算同一 invocation 必须失败(不得重复应用)。
    assert_eq!(
        bus.settle(invocation),
        Err(SettleRejection::NotInFlight { invocation })
    );
    assert_eq!(bus.target().applied.len(), 1, "不得重复应用");
}

#[test]
fn settle_after_the_declared_timeout_is_rejected() {
    let mut bus = bus();
    let mut cmd = command(&mut bus, "key-0014", set_visible("a", true));
    cmd.timeout_ms = 100;
    let invocation = bus.submit(cmd, 1_000).unwrap();

    // 未超时:正常结算。
    assert_eq!(bus.settle_at(invocation, 1_050), Ok(BehaviorRevision(1)));

    // 超时:不应用。
    let mut slow = command(&mut bus, "key-0015", set_visible("b", true));
    slow.timeout_ms = 100;
    let slow_invocation = bus.submit(slow, 2_000).unwrap();
    assert_eq!(
        bus.settle_at(slow_invocation, 2_101),
        Err(SettleRejection::TimedOut {
            elapsed_ms: 101,
            timeout_ms: 100
        })
    );
    assert_eq!(bus.target().applied.len(), 1, "超时命令不得应用");
    // timeout_ms = 0 表示不设时限,不受时钟影响。
    let mut unlimited = command(&mut bus, "key-0016", set_visible("c", true));
    unlimited.timeout_ms = 0;
    unlimited.expected_revision = bus.revision();
    let unlimited_invocation = bus.submit(unlimited, 3_000).unwrap();
    assert!(bus.settle_at(unlimited_invocation, 99_999).is_ok());
}

#[test]
fn apply_failure_is_distinct_and_never_retried_implicitly() {
    let mut bus = CommandBus::new(
        CommandBudget::default(),
        capabilities(),
        Recorder {
            applied: Vec::new(),
            reject: true,
        },
    );
    let invocation = submit(&mut bus, "key-0017", set_visible("a", true), 0).unwrap();
    match bus.settle(invocation) {
        Err(SettleRejection::ApplyFailed { reason }) => {
            assert!(reason.contains("rejects"), "原因应透传目标说明: {reason}")
        }
        other => panic!("期望 ApplyFailed,实际 {other:?}"),
    }
    assert_eq!(
        bus.revision(),
        BehaviorRevision(0),
        "应用失败不推进 revision"
    );
    assert_eq!(bus.in_flight_len(), 0, "命令必须出在途以免重复应用");
    assert_eq!(bus.counters().apply_failed, 1);
    assert_eq!(
        bus.settle(invocation),
        Err(SettleRejection::NotInFlight { invocation })
    );
}

#[test]
fn counters_track_every_real_event() {
    let mut bus = bus();
    let settled = submit(&mut bus, "key-0025", set_visible("a", true), 0).unwrap();
    let cancelled = submit(&mut bus, "key-0026", set_visible("b", true), 0).unwrap();
    bus.settle(settled).unwrap();
    bus.cancel(cancelled);

    let counters = bus.counters();
    assert_eq!(counters.submitted, 2);
    assert_eq!(counters.settled, 1);
    assert_eq!(counters.cancelled, 1);
    assert_eq!(counters.rejected_invalid, 0);
    assert_eq!(counters.rejected_stale_revision, 0);
    assert_eq!(counters.rejected_duplicate_idempotency, 0);
    assert_eq!(counters.rejected_missing_capability, 0);
    assert_eq!(counters.rejected_budget, 0);
    assert_eq!(counters.apply_failed, 0);
    assert_eq!(bus.revision(), BehaviorRevision(1), "只有一次成功结算");
}

#[test]
fn one_settle_invalidates_earlier_expected_revisions() {
    let mut bus = bus();
    let first = submit(&mut bus, "key-0027", set_visible("a", true), 0).unwrap();
    let second = submit(&mut bus, "key-0028", set_visible("b", true), 0).unwrap();
    bus.settle(first).unwrap();
    // 第二条的前置 revision 已过期:结算必须拒绝——这就是「过期命令不得改变新状态」。
    assert!(matches!(
        bus.settle(second),
        Err(SettleRejection::RevisionMoved { .. })
    ));
    assert_eq!(bus.target().applied.len(), 1);
}

#[test]
fn timed_out_command_cannot_later_apply_without_clock() {
    let mut bus = bus();
    let id = submit(&mut bus, "key-expire", set_visible("a", true), 0).unwrap();
    assert!(matches!(
        bus.settle_at(id, 1_001),
        Err(SettleRejection::TimedOut { .. })
    ));
    assert_eq!(bus.in_flight_len(), 0);
    assert_eq!(
        bus.settle(id),
        Err(SettleRejection::NotInFlight { invocation: id })
    );
    assert!(bus.target().applied.is_empty());
}

#[test]
fn exact_deadline_is_valid_but_expiration_releases_budget() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_in_flight: 1,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    let first = submit(&mut bus, "key-boundary", set_visible("a", true), 100).unwrap();
    assert_eq!(bus.settle_at(first, 1_100), Ok(BehaviorRevision(1)));
    let second = submit(&mut bus, "key-expired", set_visible("b", true), 200).unwrap();
    assert!(matches!(
        bus.settle_at(second, 1_201),
        Err(SettleRejection::TimedOut { .. })
    ));
    assert_eq!(bus.revision(), BehaviorRevision(1));
    assert!(matches!(
        submit(&mut bus, "key-expired", set_visible("b", true), 1_202),
        Err(SubmitRejection::DuplicateIdempotencyKey { .. })
    ));
    let next = submit(&mut bus, "key-next-1", set_visible("c", true), 1_202).unwrap();
    assert_eq!(bus.settle_at(next, 1_202), Ok(BehaviorRevision(2)));
    assert_eq!(bus.target().applied.len(), 2);
}
