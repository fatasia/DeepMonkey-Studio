use super::*;

fn host(budget: XBudget) -> XCompatibilityHost {
    XCompatibilityHost::new(true, budget).unwrap()
}
fn context(epoch: u64, now_ms: u64) -> XExecutionContext {
    XExecutionContext {
        current_epoch: epoch,
        now_ms,
        cancelled: false,
    }
}
fn request(calls: Vec<XCall>) -> XRequest {
    XRequest {
        expected_epoch: 7,
        started_at_ms: 100,
        random_seed: 42,
        resources: vec![XResource {
            id: "fixture.data".into(),
            bytes: vec![3, 5, 8],
        }],
        events: vec![
            XEvent::Pointer { x: 12.0, y: 24.0 },
            XEvent::Key { code: XKey::Enter },
        ],
        calls,
    }
}

#[test]
fn n0_lane_and_disabled_switch_never_enter_x() {
    let call = request(vec![XCall::EmitNumber(1.0)]);
    assert_eq!(
        host(XBudget::default()).evaluate(CompatibilityLane::NativeN0, &call, context(7, 100)),
        Err(XRejection::NativeN0Isolated)
    );
    let disabled = XCompatibilityHost::new(false, XBudget::default()).unwrap();
    assert_eq!(
        disabled.evaluate(CompatibilityLane::ExperimentalX, &call, context(7, 100)),
        Err(XRejection::Disabled)
    );
}

#[test]
fn injected_resources_clock_random_and_events_are_deterministic() {
    let calls = vec![XCall::Sequence(vec![
        XCall::ReadClock,
        XCall::DrawRandom,
        XCall::ReadResourceByte {
            resource_id: "fixture.data".into(),
            offset: 1,
        },
        XCall::ReadEvent { index: 0 },
    ])];
    let host = host(XBudget::default());
    let first = host
        .evaluate(
            CompatibilityLane::ExperimentalX,
            &request(calls.clone()),
            context(7, 125),
        )
        .unwrap();
    let second = host
        .evaluate(
            CompatibilityLane::ExperimentalX,
            &request(calls),
            context(7, 125),
        )
        .unwrap();
    assert_eq!(first.messages(), second.messages());
    assert_eq!(first.messages()[0], XMessage::Clock(125));
    assert_eq!(
        first.messages()[2],
        XMessage::ResourceByte {
            resource_id: "fixture.data".into(),
            offset: 1,
            value: 5
        }
    );
    assert_eq!(
        first.messages()[3],
        XMessage::Event(XEvent::Pointer { x: 12.0, y: 24.0 })
    );
}

#[test]
fn every_hard_budget_fails_closed_without_a_candidate() {
    let base = XBudget::default();
    let cpu = host(XBudget {
        max_cpu_units: 1,
        ..base
    });
    assert_eq!(
        cpu.evaluate(
            CompatibilityLane::ExperimentalX,
            &request(vec![XCall::ReadClock, XCall::ReadClock]),
            context(7, 100)
        ),
        Err(XRejection::CpuBudgetExceeded)
    );
    let memory = host(XBudget {
        max_memory_bytes: 16,
        max_message_bytes: 8,
        ..base
    });
    assert_eq!(
        memory.evaluate(
            CompatibilityLane::ExperimentalX,
            &request(vec![]),
            context(7, 100)
        ),
        Err(XRejection::MemoryBudgetExceeded)
    );
    let depth = host(XBudget {
        max_call_depth: 1,
        ..base
    });
    assert_eq!(
        depth.evaluate(
            CompatibilityLane::ExperimentalX,
            &request(vec![XCall::Sequence(vec![XCall::ReadClock])]),
            context(7, 100)
        ),
        Err(XRejection::CallDepthExceeded)
    );
    let messages = host(XBudget {
        max_messages: 1,
        ..base
    });
    assert_eq!(
        messages.evaluate(
            CompatibilityLane::ExperimentalX,
            &request(vec![XCall::ReadClock, XCall::DrawRandom]),
            context(7, 100)
        ),
        Err(XRejection::MessageBudgetExceeded)
    );
    let message_bytes = host(XBudget {
        max_message_bytes: 7,
        ..base
    });
    assert_eq!(
        message_bytes.evaluate(
            CompatibilityLane::ExperimentalX,
            &request(vec![XCall::ReadClock]),
            context(7, 100)
        ),
        Err(XRejection::MessageBudgetExceeded)
    );
    let wall = host(XBudget {
        max_wall_clock_ms: 5,
        ..base
    });
    assert_eq!(
        wall.evaluate(
            CompatibilityLane::ExperimentalX,
            &request(vec![]),
            context(7, 106)
        ),
        Err(XRejection::WallClockBudgetExceeded)
    );
}

#[test]
fn cancellation_timeout_and_old_epoch_are_rechecked_before_publish() {
    let host = host(XBudget {
        max_wall_clock_ms: 10,
        ..XBudget::default()
    });
    let source = request(vec![XCall::EmitNumber(9.0)]);
    assert_eq!(
        host.evaluate(
            CompatibilityLane::ExperimentalX,
            &source,
            XExecutionContext {
                cancelled: true,
                ..context(7, 100)
            }
        ),
        Err(XRejection::Cancelled)
    );
    assert_eq!(
        host.evaluate(CompatibilityLane::ExperimentalX, &source, context(8, 100)),
        Err(XRejection::StaleEpoch {
            expected: 7,
            current: 8
        })
    );
    let stale = host
        .evaluate(CompatibilityLane::ExperimentalX, &source, context(7, 105))
        .unwrap();
    assert_eq!(
        host.publish(CompatibilityLane::ExperimentalX, stale, context(8, 105)),
        Err(XRejection::StaleEpoch {
            expected: 7,
            current: 8
        })
    );
    let late = host
        .evaluate(CompatibilityLane::ExperimentalX, &source, context(7, 105))
        .unwrap();
    assert_eq!(
        host.publish(CompatibilityLane::ExperimentalX, late, context(7, 111)),
        Err(XRejection::WallClockBudgetExceeded)
    );
    let cancelled = host
        .evaluate(CompatibilityLane::ExperimentalX, &source, context(7, 105))
        .unwrap();
    assert_eq!(
        host.publish(
            CompatibilityLane::ExperimentalX,
            cancelled,
            XExecutionContext {
                cancelled: true,
                ..context(7, 105)
            }
        ),
        Err(XRejection::Cancelled)
    );
}

#[test]
fn invalid_resources_events_and_numbers_never_produce_partial_messages() {
    let host = host(XBudget::default());
    for calls in [
        vec![
            XCall::ReadClock,
            XCall::ReadResourceByte {
                resource_id: "missing".into(),
                offset: 0,
            },
        ],
        vec![XCall::ReadEvent { index: 9 }],
        vec![XCall::EmitNumber(f64::NAN)],
    ] {
        assert!(matches!(
            host.evaluate(
                CompatibilityLane::ExperimentalX,
                &request(calls),
                context(7, 100)
            ),
            Err(XRejection::InvalidInput(_))
        ));
    }
    let mut bad_event = request(vec![XCall::ReadEvent { index: 0 }]);
    bad_event.events[0] = XEvent::Pointer {
        x: f64::INFINITY,
        y: 0.0,
    };
    assert!(matches!(
        host.evaluate(
            CompatibilityLane::ExperimentalX,
            &bad_event,
            context(7, 100)
        ),
        Err(XRejection::InvalidInput(_))
    ));
}
