use super::*;

#[test]
fn stable_id_rule_rejects_unsafe_identities() {
    assert!(stable_node_id("scene.node-1:a_b"));
    assert!(!stable_node_id(""));
    assert!(!stable_node_id("has space"));
    assert!(!stable_node_id("path/sep"));
    assert!(!stable_node_id("back\\slash"));
    assert!(!stable_node_id("quote\"char"));
    assert!(!stable_node_id(&"x".repeat(129)));
}

#[test]
fn unsupported_schema_version_is_rejected() {
    let mut bus = bus();
    let mut cmd = command(&mut bus, "key-0001", set_visible("a", true));
    cmd.schema_version = 99;
    assert_eq!(
        bus.submit(cmd, 0),
        Err(SubmitRejection::UnsupportedSchemaVersion { found: 99 })
    );
    assert_eq!(bus.in_flight_len(), 0, "被拒命令不得进入在途");
}

#[test]
fn idempotency_key_length_is_bounded_at_both_ends() {
    let mut bus = bus();
    assert!(matches!(
        submit(&mut bus, "short", set_visible("a", true), 0),
        Err(SubmitRejection::InvalidIdempotencyKey { .. })
    ));
    let long = "k".repeat(257);
    assert!(matches!(
        submit(&mut bus, &long, set_visible("a", true), 0),
        Err(SubmitRejection::InvalidIdempotencyKey { .. })
    ));
    assert_eq!(bus.in_flight_len(), 0);
}

#[test]
fn missing_capability_is_rejected_and_never_applied() {
    let mut bus = bus();
    let mut cmd = command(&mut bus, "key-0011", set_visible("a", true));
    cmd.required_capacity = Some(CapabilityId(9));
    assert_eq!(
        bus.submit(cmd, 0),
        Err(SubmitRejection::MissingCapability {
            capability: CapabilityId(9)
        })
    );
    assert_eq!(bus.in_flight_len(), 0);
    assert_eq!(bus.counters().rejected_missing_capability, 1);

    // 已声明的能力通过。
    let mut ok = command(&mut bus, "key-0012", set_visible("a", true));
    ok.required_capacity = Some(CapabilityId(1));
    bus.submit(ok, 0).expect("已声明能力应通过");
}

#[test]
fn timeout_budget_is_enforced_at_submit() {
    let mut bus = CommandBus::new(
        CommandBudget {
            max_command_timeout_ms: 500,
            ..CommandBudget::default()
        },
        capabilities(),
        Recorder::default(),
    );
    let mut cmd = command(&mut bus, "key-0013", set_visible("a", true));
    cmd.timeout_ms = 501;
    assert_eq!(
        bus.submit(cmd, 0),
        Err(SubmitRejection::TimeoutBudgetExceeded {
            requested_ms: 501,
            max_ms: 500
        })
    );
    assert_eq!(bus.counters().rejected_budget, 1);
}

#[test]
fn invalid_payloads_are_rejected_with_specific_reasons() {
    let mut bus = bus();
    for (key, payload, expect) in [
        (
            "key-0018",
            BehaviorPayload::SetProperty {
                node_id: "a".into(),
                property: BehaviorProperty::Opacity,
                value: Scalar::Number(f64::NAN),
            },
            "property number must be finite",
        ),
        (
            "key-0019",
            BehaviorPayload::SetPage {
                node_id: "a".into(),
                page: 70_000,
            },
            "page index out of range",
        ),
        (
            "key-0020",
            set_visible("bad id", true),
            "identity is not a stable id",
        ),
        (
            "key-0021",
            BehaviorPayload::RequestData {
                dataset_id: "path/x".into(),
                expected_source_version: None,
            },
            "identity is not a stable id",
        ),
    ] {
        assert_eq!(
            submit(&mut bus, key, payload, 0),
            Err(SubmitRejection::InvalidPayload { reason: expect }),
            "key {key}"
        );
    }
    assert_eq!(bus.in_flight_len(), 0);
}

#[test]
fn duplicate_invocation_identity_is_rejected() {
    let mut bus = bus();
    let first = command(&mut bus, "key-0022", set_visible("a", true));
    let reused = first.invocation_id;
    bus.submit(first, 0).unwrap();

    let mut second = command(&mut bus, "key-0023", set_visible("b", true));
    second.invocation_id = reused;
    assert_eq!(
        bus.submit(second, 0),
        Err(SubmitRejection::DuplicateInvocation { invocation: reused })
    );
}

#[test]
fn reserved_invocation_zero_is_rejected() {
    let mut bus = bus();
    let mut cmd = command(&mut bus, "key-0024", set_visible("a", true));
    cmd.invocation_id = InvocationId(0);
    assert!(matches!(
        bus.submit(cmd, 0),
        Err(SubmitRejection::InvalidInvocationId { .. })
    ));
}
