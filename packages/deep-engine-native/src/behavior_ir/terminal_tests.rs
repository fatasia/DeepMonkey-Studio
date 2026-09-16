use super::*;

#[test]
fn terminal_invocations_reject_reuse_before_delayed_callbacks() {
    for outcome in ["timeout", "settled", "failed", "cancelled"] {
        let mut bus = CommandBus::new(
            CommandBudget::default(),
            capabilities(),
            Recorder {
                reject: outcome == "failed",
                ..Recorder::default()
            },
        );
        let old = submit(&mut bus, "key-original", set_visible("old", true), 0).unwrap();
        match outcome {
            "timeout" => assert!(matches!(
                bus.settle_at(old, 1_001),
                Err(SettleRejection::TimedOut { .. })
            )),
            "settled" => assert!(bus.settle(old).is_ok()),
            "failed" => assert!(matches!(
                bus.settle(old),
                Err(SettleRejection::ApplyFailed { .. })
            )),
            "cancelled" => assert_eq!(
                bus.cancel(old),
                CancelOutcome::Cancelled { invocation: old }
            ),
            _ => unreachable!(),
        }
        let revision = bus.revision();
        let applied = bus.target().applied.clone();
        let reused = command_at(old, revision, "key-replacement", set_visible("new", true));
        assert_eq!(
            bus.submit(reused, 1_002),
            Err(SubmitRejection::DuplicateInvocation { invocation: old }),
            "{outcome}"
        );
        assert_eq!(bus.in_flight_len(), 0);
        // 身份拒绝不得占用新幂等键;使用新身份仍可提交。
        let fresh = submit(&mut bus, "key-replacement", set_visible("new", true), 1_002).unwrap();
        let expected = if outcome == "cancelled" {
            SettleRejection::Cancelled { invocation: old }
        } else {
            SettleRejection::NotInFlight { invocation: old }
        };
        assert_eq!(bus.settle(old), Err(expected.clone()));
        assert_eq!(bus.settle_at(old, 1_003), Err(expected));
        assert_eq!(bus.in_flight_len(), 1);
        assert_eq!(bus.revision(), revision);
        assert_eq!(bus.target().applied, applied);
        if outcome == "failed" {
            assert!(matches!(
                bus.settle(fresh),
                Err(SettleRejection::ApplyFailed { .. })
            ));
        } else {
            assert_eq!(bus.settle(fresh), Ok(BehaviorRevision(revision.0 + 1)));
            assert_eq!(bus.target().applied.last(), Some(&set_visible("new", true)));
        }
    }
}

#[test]
fn terminal_memory_is_shared_bounded_and_fifo() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_cancelled_memory: 2,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    for (id, key) in [(9, "key-cancelled"), (2, "key-timeout"), (6, "key-settled")] {
        let cmd = command_at(
            InvocationId(id),
            bus.revision(),
            key,
            set_visible("a", true),
        );
        bus.submit(cmd, 0).unwrap();
        match id {
            9 => {
                bus.cancel(InvocationId(id));
            }
            2 => {
                assert!(matches!(
                    bus.settle_at(InvocationId(id), 1_001),
                    Err(SettleRejection::TimedOut { .. })
                ));
            }
            _ => {
                bus.settle(InvocationId(id)).unwrap();
            }
        }
    }
    assert_eq!(bus.counters().cancel_memory_forgotten, 1);
    assert_eq!(
        bus.settle(InvocationId(9)),
        Err(SettleRejection::NotInFlight {
            invocation: InvocationId(9)
        })
    );
    for id in [2, 6] {
        let cmd = command_at(
            InvocationId(id),
            bus.revision(),
            "key-retained",
            set_visible("b", true),
        );
        assert_eq!(
            bus.submit(cmd, 1_002),
            Err(SubmitRejection::DuplicateInvocation {
                invocation: InvocationId(id)
            })
        );
    }
    // 有损窗口之外总线不保证去重;宿主仍有责任不复用旧身份。
    let forgotten = command_at(
        InvocationId(9),
        bus.revision(),
        "key-forgotten",
        set_visible("b", true),
    );
    assert_eq!(bus.submit(forgotten, 1_002), Ok(InvocationId(9)));
}
