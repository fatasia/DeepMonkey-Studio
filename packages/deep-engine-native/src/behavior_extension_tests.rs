//! P3-03 扩展生命周期测试。
//!
//! 结构:先过任务矩阵九条(注册成功/签名错误/ABI 不兼容/权限不足/预算超限/
//! 撤销后拒绝/二次撤销/回退无半状态/兼容报告字段),再做门控与总线对接的
//! 对抗式自查(未注册提交、越权能力、超时份额、跟踪容量、总线拒绝透传、
//! 非法描述符、策略形状)。
//!
//! 借用纪律与 behavior_ir_tests 相同:先取命令再提交,禁止
//! `host.submit(command(&mut host, …))` 的双重可变借用。

use super::contract::ExtensionDescriptor;
use super::signing::sign_descriptor;
use super::*;
use crate::behavior_ir::{
    BEHAVIOR_IR_SCHEMA_VERSION, BehaviorCommand, BehaviorPayload, BehaviorRevision, CapabilityId,
    CommandBudget, CommandBus, HostCapabilities, InvocationId, SettleRejection, SubmitRejection,
};
use std::collections::BTreeSet;

/// 测试用目标:与 behavior_ir_tests 同款记录器。
#[derive(Debug, Default)]
struct Recorder {
    applied: Vec<BehaviorPayload>,
}

impl crate::behavior_ir::BehaviorTarget for Recorder {
    fn apply(&mut self, payload: &BehaviorPayload) -> Result<(), String> {
        self.applied.push(payload.clone());
        Ok(())
    }
}

fn key() -> Vec<u8> {
    b"p3-03-shared-secret".to_vec()
}

fn caps(list: &[u16]) -> BTreeSet<CapabilityId> {
    list.iter().copied().map(CapabilityId).collect()
}

fn policy() -> ExtensionHostPolicy {
    ExtensionHostPolicy {
        signing_key: key(),
        supported_abi_versions: BTreeSet::from([1, 2]),
        granted_capabilities: caps(&[1, 2]),
        budget_ceiling: CommandBudget::default(),
    }
}

fn bus() -> CommandBus<Recorder> {
    CommandBus::new(
        CommandBudget::default(),
        HostCapabilities::new(caps(&[1, 2, 3])),
        Recorder::default(),
    )
}

/// 未签名的基础描述符:身份合法、ABI 1(在支持集)、能力 {1}(宿主愿授)、
/// 预算 = 宿主天花板(全部合规)。
fn descriptor(id: &str) -> ExtensionDescriptor {
    ExtensionDescriptor {
        id: id.into(),
        version: 1,
        abi_version: 1,
        required_capabilities: caps(&[1]),
        budget: CommandBudget::default(),
        signature: String::new(),
    }
}

/// 用宿主密钥签名后的描述符(注册成功路径的最小改动量)。
fn signed(mut descriptor: ExtensionDescriptor) -> ExtensionDescriptor {
    sign_descriptor(&mut descriptor, &key());
    descriptor
}

fn host() -> ExtensionHost<Recorder> {
    ExtensionHost::new(policy(), bus()).expect("test policy is valid")
}

/// 从托管总线取下一条合法命令(invocation/revision 都取当前值)。
fn command(
    host: &mut ExtensionHost<Recorder>,
    idempotency: &str,
    timeout_ms: u64,
    required: Option<CapabilityId>,
) -> BehaviorCommand {
    let invocation = host.bus_mut().next_invocation_id();
    let revision = host.bus_mut().revision();
    BehaviorCommand {
        schema_version: BEHAVIOR_IR_SCHEMA_VERSION,
        node_id: "scene.node".into(),
        invocation_id: invocation,
        expected_revision: revision,
        idempotency_key: idempotency.into(),
        required_capacity: required,
        payload: BehaviorPayload::ClearSelection,
        timeout_ms,
    }
}

/// 便捷提交:先取命令再借用 host,规避双重可变借用。
fn submit(
    host: &mut ExtensionHost<Recorder>,
    extension_id: &str,
    idempotency: &str,
    timeout_ms: u64,
    required: Option<CapabilityId>,
    now_ms: u64,
) -> Result<InvocationId, ExtensionSubmitRejection> {
    let cmd = command(host, idempotency, timeout_ms, required);
    host.submit(extension_id, cmd, now_ms)
}

// ---------------------------------------------------------------- 任务矩阵

#[test]
fn register_success_enters_ledger_with_clamped_share() {
    let mut host = host();
    let mut request = descriptor("vendor.grid");
    // 申请宿主不授的能力({7} 不在愿授集)必须在注册时被整体拒绝(fail-closed),
    // 不存在「缺权注册成功后部分授权」的中间态——该行为由
    // register_rejects_missing_capabilities 单独锁定。
    request.required_capabilities = caps(&[1, 2]);
    // 申请低于天花板的份额:生效预算应等于申请值,而不是悄悄给满天花板。
    request.budget.max_in_flight = 10;
    let report = host.register(signed(request)).expect("well signed");

    assert!(report.accepted);
    assert!(report.abi_compatible);
    assert_eq!(report.signature_ok, Some(true));
    assert!(report.missing_capabilities.is_empty());
    assert!(report.budget_deltas.is_empty());
    assert_eq!(report.host_abi, HOST_EXTENSION_ABI_VERSION);

    let record = host.record("vendor.grid").expect("registered");
    assert_eq!(record.granted, caps(&[1, 2]));
    assert_eq!(record.effective_budget.max_in_flight, 10);
    assert_eq!(host.counters().registered, 1);
}

#[test]
fn register_rejects_bad_signature_without_half_state() {
    let mut host = host();
    let mut tampered = signed(descriptor("vendor.grid"));
    tampered.version = 99; // 签名后改内容:签名必然不再匹配覆盖字节
    assert!(matches!(
        host.register(tampered),
        Err(RegistrationRejection::SignatureMismatch { .. })
    ));
    assert!(host.record("vendor.grid").is_none());
    assert!(!host.is_revoked("vendor.grid"));
    assert_eq!(host.counters().rejected_signature, 1);

    // 回退:同一 id 用正确签名可立即注册成功(失败未留下任何占位)。
    let report = host
        .register(signed(descriptor("vendor.grid")))
        .expect("retry");
    assert!(report.accepted);
}

#[test]
fn register_rejects_incompatible_abi_with_report() {
    let mut host = host();
    let mut request = descriptor("vendor.grid");
    request.abi_version = 99;
    let rejection = host.register(signed(request)).unwrap_err();
    match &rejection {
        RegistrationRejection::AbiIncompatible { report } => {
            assert_eq!(report.requested_abi, 99);
            assert_eq!(report.host_abi, HOST_EXTENSION_ABI_VERSION);
            assert_eq!(report.supported_abis, vec![1, 2]);
            assert!(!report.abi_compatible);
            assert!(!report.accepted);
            assert_eq!(report.signature_ok, Some(true)); // 签名关已过,卡在 ABI
        }
        other => panic!("expected AbiIncompatible, got {other:?}"),
    }
    assert!(host.record("vendor.grid").is_none());
}

#[test]
fn register_rejects_missing_capabilities() {
    let mut host = host();
    let mut request = descriptor("vendor.grid");
    request.required_capabilities = caps(&[1, 7, 9]); // 宿主只愿授 {1,2}
    let rejection = host.register(signed(request)).unwrap_err();
    match rejection {
        RegistrationRejection::MissingCapabilities { report } => {
            assert_eq!(
                report.missing_capabilities,
                vec![CapabilityId(7), CapabilityId(9)]
            );
            assert!(report.budget_deltas.is_empty());
        }
        other => panic!("expected MissingCapabilities, got {other:?}"),
    }
    assert!(host.record("vendor.grid").is_none());
}

#[test]
fn register_rejects_budget_exceeded_with_deltas() {
    let mut host = host();
    let mut request = descriptor("vendor.grid");
    // 上限维超天花板 + 下限维削弱势能(幂等键最短长度低于宿主标准)。
    request.budget.max_in_flight = 128;
    request.budget.min_idempotency_key_len = 4;
    let rejection = host.register(signed(request)).unwrap_err();
    match rejection {
        RegistrationRejection::BudgetExceeded { report } => {
            assert_eq!(
                report.budget_deltas,
                vec![
                    BudgetDelta {
                        dimension: "max_in_flight",
                        requested: 128,
                        ceiling: 64,
                    },
                    BudgetDelta {
                        dimension: "min_idempotency_key_len",
                        requested: 4,
                        ceiling: 8,
                    },
                ]
            );
        }
        other => panic!("expected BudgetExceeded, got {other:?}"),
    }
    assert!(host.record("vendor.grid").is_none());
}

#[test]
fn revoked_extension_is_rejected_and_in_flight_cancelled() {
    let mut host = host();
    host.register(signed(descriptor("vendor.grid")))
        .expect("registered");
    let first = submit(&mut host, "vendor.grid", "idem-key-1", 1_000, None, 0).expect("submitted");
    submit(&mut host, "vendor.grid", "idem-key-2", 1_000, None, 0).expect("submitted");
    assert_eq!(host.bus().in_flight_len(), 2);

    assert_eq!(host.revoke("vendor.grid"), RevokeOutcome::Revoked);
    // 撤销即刻作废其全部在途命令:settle 必须得到 Cancelled,状态不得被推进。
    assert_eq!(host.counters().invocations_cancelled_on_revoke, 2);
    assert_eq!(host.bus().in_flight_len(), 0);
    assert_eq!(
        host.bus_mut().settle(first),
        Err(SettleRejection::Cancelled { invocation: first })
    );
    assert_eq!(host.bus().revision(), BehaviorRevision(0));

    // 撤销后的新提交一律拒绝。
    assert_eq!(
        submit(&mut host, "vendor.grid", "idem-key-3", 1_000, None, 1),
        Err(ExtensionSubmitRejection::Revoked {
            extension_id: "vendor.grid".into(),
        })
    );
}

#[test]
fn revoke_is_idempotent_and_reports_unknown() {
    let mut host = host();
    host.register(signed(descriptor("vendor.grid")))
        .expect("registered");
    assert_eq!(host.revoke("vendor.grid"), RevokeOutcome::Revoked);
    // 二次撤销是 no-op:不重复计数成功,也不变成 Unknown。
    assert_eq!(host.revoke("vendor.grid"), RevokeOutcome::AlreadyRevoked);
    assert_eq!(host.revoke("never.seen"), RevokeOutcome::Unknown);
    let counters = host.counters();
    assert_eq!(counters.revoked, 1);
    assert_eq!(counters.revoke_missed, 2);
}

#[test]
fn revoked_id_cannot_revive_via_reregistration() {
    let mut host = host();
    host.register(signed(descriptor("vendor.grid")))
        .expect("registered");
    host.revoke("vendor.grid");
    assert!(matches!(
        host.register(signed(descriptor("vendor.grid"))),
        Err(RegistrationRejection::IdRevoked { .. })
    ));
    assert!(host.record("vendor.grid").is_none());
}

#[test]
fn every_rejection_path_leaves_no_half_state() {
    let mut host = host();

    let mut bad_signature = descriptor("vendor.grid");
    bad_signature.signature = "f".repeat(64); // 形状合法但不是真签名
    let mut bad_abi = descriptor("vendor.grid");
    bad_abi.abi_version = 99;
    let mut bad_caps = descriptor("vendor.grid");
    bad_caps.required_capabilities = caps(&[7]);
    let mut bad_budget = descriptor("vendor.grid");
    bad_budget.budget.max_in_flight = 128;

    for request in [bad_signature, bad_abi, bad_caps, bad_budget] {
        assert!(host.register(request).is_err(), "expected rejection");
        assert!(host.record("vendor.grid").is_none(), "no ledger entry");
        assert!(!host.is_revoked("vendor.grid"), "no revoke residue");
        assert!(
            submit(&mut host, "vendor.grid", "idem-key-x", 1_000, None, 0).is_err(),
            "unregistered extension cannot submit"
        );
    }
    // 全部失败之后,同 id 的合法注册一次通过(无占位、无黑名单残留)。
    assert!(host.register(signed(descriptor("vendor.grid"))).is_ok());
}

#[test]
fn compatibility_report_carries_negotiation_fields() {
    let mut host = host();
    let mut request = descriptor("vendor.grid");
    request.version = 5;
    request.abi_version = 3;
    request.required_capabilities = caps(&[1, 9]);
    request.budget.max_idempotency_keys = 9_999;

    // evaluate 是纯探测:不改台账,也不预签签名。
    let probe = host.evaluate(&request);
    assert_eq!(probe.extension_id, "vendor.grid");
    assert_eq!(probe.requested_version, 5);
    assert_eq!(probe.requested_abi, 3);
    assert_eq!(probe.supported_abis, vec![1, 2]);
    assert!(!probe.abi_compatible);
    assert_eq!(probe.missing_capabilities, vec![CapabilityId(9)]);
    assert_eq!(probe.budget_deltas.len(), 1);
    assert_eq!(probe.signature_ok, None);
    assert!(!probe.accepted);
    assert!(host.record("vendor.grid").is_none());

    // register 的拒绝报告与探测字段一致(签名关除外)。
    let rejection = host.register(signed(request)).unwrap_err();
    let report = rejection.report();
    assert_eq!(report.requested_abi, 3);
    assert_eq!(report.signature_ok, Some(true));
    assert_eq!(report.supported_abis, probe.supported_abis);
}

// ---------------------------------------------------- 门控与总线对接(自查)

#[test]
fn unregistered_extension_cannot_submit() {
    let mut host = host();
    assert_eq!(
        submit(&mut host, "ghost.ext", "idem-key-1", 1_000, None, 0),
        Err(ExtensionSubmitRejection::NotRegistered {
            extension_id: "ghost.ext".into(),
        })
    );
}

#[test]
fn command_beyond_extension_grant_is_rejected_even_if_host_declares_it() {
    let mut host = host();
    // 宿主总线整体声明 {1,2,3},但扩展只被授 {1}:能力门控消费的是授权集。
    host.register(signed(descriptor("vendor.grid")))
        .expect("registered");
    assert_eq!(
        submit(
            &mut host,
            "vendor.grid",
            "idem-key-1",
            1_000,
            Some(CapabilityId(3)),
            0
        ),
        Err(ExtensionSubmitRejection::CapabilityNotGranted {
            capability: CapabilityId(3),
        })
    );
    // 授权范围内的能力命令通过,并真正进入总线的在途。
    let invocation = submit(
        &mut host,
        "vendor.grid",
        "idem-key-2",
        1_000,
        Some(CapabilityId(1)),
        0,
    )
    .expect("granted capability passes");
    assert_eq!(host.bus().in_flight_len(), 1);
    assert!(host.release("vendor.grid", invocation));
}

#[test]
fn command_timeout_beyond_extension_share_is_rejected() {
    let mut host = host();
    let mut request = descriptor("vendor.grid");
    request.budget.max_command_timeout_ms = 500; // 天花板 30_000,份额更紧
    host.register(signed(request)).expect("registered");
    assert_eq!(
        submit(&mut host, "vendor.grid", "idem-key-1", 1_000, None, 0),
        Err(ExtensionSubmitRejection::ExtensionTimeoutExceeded {
            requested_ms: 1_000,
            allowed_ms: 500,
        })
    );
    assert!(submit(&mut host, "vendor.grid", "idem-key-2", 500, None, 0).is_ok());
}

#[test]
fn tracked_share_exhaustion_and_release() {
    let mut host = host();
    let mut request = descriptor("vendor.grid");
    request.budget.max_in_flight = 2;
    host.register(signed(request)).expect("registered");

    let first = submit(&mut host, "vendor.grid", "idem-key-1", 5_000, None, 0).expect("1st");
    submit(&mut host, "vendor.grid", "idem-key-2", 5_000, None, 0).expect("2nd");
    assert_eq!(host.tracked_len("vendor.grid"), 2);
    assert_eq!(
        submit(&mut host, "vendor.grid", "idem-key-3", 5_000, None, 0),
        Err(ExtensionSubmitRejection::ExtensionInFlightExhausted {
            extension_id: "vendor.grid".into(),
            max: 2,
        })
    );

    // 结算 + release 归还名额后,新命令再次可提交;重复 release 是 false 而非错误。
    host.bus_mut().settle(first).expect("settled");
    assert!(host.release("vendor.grid", first));
    assert!(!host.release("vendor.grid", first));
    assert!(submit(&mut host, "vendor.grid", "idem-key-3", 5_000, None, 0).is_ok());
}

#[test]
fn bus_rejections_pass_through_unchanged() {
    let mut host = host();
    host.register(signed(descriptor("vendor.grid")))
        .expect("registered");
    submit(&mut host, "vendor.grid", "idem-key-1", 1_000, None, 0).expect("first");
    // 同幂等键重复提交:总线侧拒绝原样透传,不重包成扩展错误。
    let second = command(&mut host, "idem-key-1", 1_000, None);
    assert_eq!(
        host.submit("vendor.grid", second, 0),
        Err(ExtensionSubmitRejection::BusRejected(
            SubmitRejection::DuplicateIdempotencyKey {
                key: "idem-key-1".into(),
            }
        ))
    );
    assert_eq!(host.counters().submit_rejected_bus, 1);
}

#[test]
fn invalid_descriptors_are_rejected_before_policy_gates() {
    let mut host = host();

    let mut zero_version = descriptor("vendor.grid");
    zero_version.version = 0;
    let mut bad_id = descriptor("bad id!");
    bad_id.signature = "a".repeat(64);
    let mut short_signature = descriptor("vendor.grid");
    short_signature.signature = "a".repeat(63);
    let mut non_hex_signature = descriptor("vendor.grid");
    non_hex_signature.signature = "z".repeat(64);
    let mut zero_budget = descriptor("vendor.grid");
    zero_budget.budget.max_in_flight = 0;

    for request in [
        zero_version,
        bad_id,
        short_signature,
        non_hex_signature,
        zero_budget,
    ] {
        match host.register(request) {
            Err(RegistrationRejection::InvalidDescriptor { reason, .. }) => {
                assert!(!reason.is_empty());
            }
            other => panic!("expected InvalidDescriptor, got {other:?}"),
        }
    }
    assert!(host.record("vendor.grid").is_none());
    assert_eq!(host.counters().rejected_invalid_descriptor, 5);
}

#[test]
fn duplicate_registration_is_rejected() {
    let mut host = host();
    host.register(signed(descriptor("vendor.grid")))
        .expect("first");
    assert!(matches!(
        host.register(signed(descriptor("vendor.grid"))),
        Err(RegistrationRejection::Duplicate { .. })
    ));
    assert_eq!(host.counters().rejected_duplicate, 1);
}

#[test]
fn host_policy_shape_is_validated_at_construction() {
    let mut empty_key = policy();
    empty_key.signing_key = Vec::new();
    let mut no_abis = policy();
    no_abis.supported_abi_versions = BTreeSet::new();
    let mut zero_ceiling = policy();
    zero_ceiling.budget_ceiling.max_command_timeout_ms = 0;

    for policy in [empty_key, no_abis, zero_ceiling] {
        assert!(ExtensionHost::new(policy, bus()).is_err());
    }
}

/// invocation 身份经门控往返保持:门控不重编身份,总线看到的即提交者所给。
#[test]
fn invocation_identity_roundtrip_through_gate() {
    let mut host = host();
    host.register(signed(descriptor("vendor.grid")))
        .expect("registered");
    let invocation =
        submit(&mut host, "vendor.grid", "idem-key-1", 1_000, None, 0).expect("submitted");
    assert_ne!(invocation, InvocationId(0));
    assert_eq!(host.bus().in_flight_len(), 1);
}
