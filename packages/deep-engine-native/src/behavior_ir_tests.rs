//! P1-21 行为 IR 与命令总线测试。
//!
//! 结构:先锁定六条合同(身份/幂等/CAS/取消/能力/预算),再做对抗式自查
//! (边界值、非法状态转移、有损记忆、结算侧 CAS、结算后不可重复应用)。

use super::*;

/// 测试用目标:记录成功应用的载荷,可被设为拒绝特定载荷。
#[derive(Debug, Default)]
struct Recorder {
    applied: Vec<BehaviorPayload>,
    reject: bool,
}

impl BehaviorTarget for Recorder {
    fn apply(&mut self, payload: &BehaviorPayload) -> Result<(), String> {
        if self.reject {
            return Err("target rejects this payload".into());
        }
        self.applied.push(payload.clone());
        Ok(())
    }
}

fn capabilities() -> HostCapabilities {
    HostCapabilities::new([CapabilityId(1), CapabilityId(2)])
}

fn bus() -> CommandBus<Recorder> {
    CommandBus::new(CommandBudget::default(), capabilities(), Recorder::default())
}

/// 构造一条合法命令。刻意接收 `revision` 值与 `invocation` 值而不是 `&mut bus`:
/// `bus.submit(command(&mut bus, …))` 会同时可变借用两次,编译不过。
fn command_at(
    invocation: InvocationId,
    revision: BehaviorRevision,
    key: &str,
    payload: BehaviorPayload,
) -> BehaviorCommand {
    BehaviorCommand {
        schema_version: BEHAVIOR_IR_SCHEMA_VERSION,
        node_id: "scene.node".into(),
        invocation_id: invocation,
        expected_revision: revision,
        idempotency_key: key.into(),
        required_capacity: None,
        payload,
        timeout_ms: 1_000,
    }
}

/// 构造一条命令(供「先改字段再提交」的用例使用)。
///
/// 注意它接收  只为取下一个 invocation 与当前 revision;
/// 因此**不得**写成 ——那会同时可变借用两次。
/// 需要一步提交时用下面的  辅助函数。
fn command(
    bus: &mut CommandBus<Recorder>,
    key: &str,
    payload: BehaviorPayload,
) -> BehaviorCommand {
    let invocation = bus.next_invocation_id();
    let revision = bus.revision();
    command_at(invocation, revision, key, payload)
}

/// 便捷提交:在内部先取 id 与 revision,再借用 bus 一次。
fn submit(
    bus: &mut CommandBus<Recorder>,
    key: &str,
    payload: BehaviorPayload,
    now_ms: u64,
) -> Result<InvocationId, SubmitRejection> {
    let invocation = bus.next_invocation_id();
    let revision = bus.revision();
    bus.submit(command_at(invocation, revision, key, payload), now_ms)
}

fn set_visible(node: &str, visible: bool) -> BehaviorPayload {
    BehaviorPayload::SetVisible {
        node_id: node.into(),
        visible,
    }
}

// ---- 合同 1:身份与结构校验 ----

/// 稳定 id 规则:非空、有界、仅安全字符。空格/路径分隔符/引号必须拒绝。
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

/// 未知 schema 版本必须拒绝(消费方不得猜测结构)。
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

// ---- 合同 2:幂等 ----

/// 同幂等键重复提交必须被拒,且不得二次预留(在途数不变)。
#[test]
fn duplicate_idempotency_key_is_rejected_without_second_reservation() {
    let mut bus = bus();
    submit(&mut bus, "same-key-1", set_visible("a", true), 0)
        .unwrap();
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

/// 幂等键长度下界与上界都要守住——空键不能当幂等凭据。
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

// ---- 合同 3:CAS(前置 revision) ----

/// 过期 revision 必须拒绝,且计入专用计数。
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

/// 结算时 revision 已被抢先推进:必须拒绝且**不应用**载荷。
#[test]
fn settle_rejects_when_revision_moved_during_flight() {
    let mut bus = bus();
    let invocation = submit(
        &mut bus,
        "key-0003", set_visible("a", true),
        0,
        ).unwrap();
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

/// 正常结算:应用载荷、推进 revision、出在途。
#[test]
fn settle_applies_payload_and_advances_revision() {
    let mut bus = bus();
    let invocation = submit(
        &mut bus,
        "key-0004", set_visible("a", true),
        0,
        ).unwrap();
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

// ---- 合同 4:取消 ----

/// 取消后结算必须被拒,且**不得**应用载荷;状态与 revision 不变。
#[test]
fn cancelled_commands_never_apply_and_are_distinguishable() {
    let mut bus = bus();
    let invocation = submit(
        &mut bus,
        "key-0005", set_visible("a", true),
        0,
        ).unwrap();
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

/// 取消释放在途额度:预算满时取消后可再提交。
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
    let first = submit(
        &mut bus,
        "key-0006", set_visible("a", true),
        0,
        ).unwrap();
    assert_eq!(
        submit(&mut bus, "key-0007", set_visible("b", true), 0),
        Err(SubmitRejection::InFlightBudgetExceeded {
            in_flight: 1,
            max: 1
        })
    );
    bus.cancel(first);
    submit(&mut bus, "key-0008", set_visible("c", true), 0)
        .expect("取消后额度应被释放");
}

/// 批量取消作废全部在途,返回被取消列表且可复算。
#[test]
fn cancel_all_voids_every_in_flight_command() {
    let mut bus = bus();
    let first = submit(
        &mut bus,
        "key-0009", set_visible("a", true),
        0,
        ).unwrap();
    let second = submit(
        &mut bus,
        "key-0010", set_visible("b", true),
        0,
        ).unwrap();
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

// ---- 合同 5:宿主能力门控 ----

/// 未声明能力的命令必须拒绝——不做「尽力而为」的降级执行。
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

// ---- 合同 6:预算 ----

/// 命令声明的超时超过宿主上界必须拒绝。
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

/// 按注入时钟判定的超时:超过声明窗口即拒绝且不应用。
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

// ---- 对抗式:非法状态转移与边界 ----

/// 应用失败必须与「不在途」区分,且命令不得重复应用、revision 不推进。
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
    let invocation = submit(
        &mut bus,
        "key-0017", set_visible("a", true),
        0,
        ).unwrap();
    match bus.settle(invocation) {
        Err(SettleRejection::ApplyFailed { reason }) => {
            assert!(reason.contains("rejects"), "原因应透传目标说明: {reason}")
        }
        other => panic!("期望 ApplyFailed,实际 {other:?}"),
    }
    assert_eq!(bus.revision(), BehaviorRevision(0), "应用失败不推进 revision");
    assert_eq!(bus.in_flight_len(), 0, "命令必须出在途以免重复应用");
    assert_eq!(bus.counters().apply_failed, 1);
    assert_eq!(
        bus.settle(invocation),
        Err(SettleRejection::NotInFlight { invocation })
    );
}

/// 非法载荷:NaN 数值、越界页码、坏 id 都必须拒绝。
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

/// 同一 invocation 身份被复用时必须拒绝(身份不得被两条命令共享)。
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
        Err(SubmitRejection::DuplicateInvocation {
            invocation: reused
        })
    );
}

/// invocation id 0 是保留值,必须拒绝。
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

/// 幂等键的有损记忆:容量触顶时遗忘最旧键并计数;遗忘后同键可再次提交
/// (这是有损语义的**诚实**表现,不是缺陷——已由计数可见)。
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
    for (index, key) in ["key-a-0001", "key-b-0002", "key-c-0003"].iter().enumerate() {
        submit(&mut bus, key, set_visible("a", true), index as u64)
            .unwrap();
    }
    assert_eq!(
        bus.counters().idempotency_forgotten,
        1,
        "容量 2 装 3 键必须遗忘 1 个"
    );
    // 被遗忘的键可再次提交:有损记忆的必然结果,计数已如实暴露。
    submit(&mut bus, "key-a-0001", set_visible("b", true), 9)
        .expect("被遗忘的键可再次使用");
}

/// 全部计数器与真实事件一一对应(账目自洽)。
#[test]
fn counters_track_every_real_event() {
    let mut bus = bus();
    let settled = submit(
        &mut bus,
        "key-0025", set_visible("a", true),
        0,
        ).unwrap();
    let cancelled = submit(
        &mut bus,
        "key-0026", set_visible("b", true),
        0,
        ).unwrap();
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

/// 结算成功后 revision 推进,使早先提交的命令自然过期(CAS 的闭环)。
#[test]
fn one_settle_invalidates_earlier_expected_revisions() {
    let mut bus = bus();
    let first = submit(
        &mut bus,
        "key-0027", set_visible("a", true),
        0,
        ).unwrap();
    let second = submit(
        &mut bus,
        "key-0028", set_visible("b", true),
        0,
        ).unwrap();
    bus.settle(first).unwrap();
    // 第二条的前置 revision 已过期:结算必须拒绝——这就是「过期命令不得改变新状态」。
    assert!(matches!(
        bus.settle(second),
        Err(SettleRejection::RevisionMoved { .. })
    ));
    assert_eq!(bus.target().applied.len(), 1);
}