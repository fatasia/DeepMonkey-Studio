//! 扩展生命周期:注册管线(签名→ABI→能力→预算→台账)与撤销。
//!
//! 注册是**单次原子判定**:五步全部在一个函数里顺序执行,任何一步失败都在
//! 写入台账之前返回——失败路径天然不留半状态,不需要事后回滚代码。
//! 撤销是终态:撤销过的 id 记入永不遗忘的黑名单,同 id 不得借重新注册复活。

use super::contract::*;
use super::signing::{hmac_sha256, signature_payload};
use crate::behavior_ir::{BehaviorTarget, CapabilityId, CommandBudget, CommandBus, InvocationId};
use std::collections::{BTreeMap, BTreeSet};

/// 在册扩展的生效授权:签名通过后的描述符快照 + 钳制后的权限/预算份额。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionRecord {
    pub descriptor: ExtensionDescriptor,
    /// 授权集 = 申请集 ∩ 宿主愿授集。命令门控以此为准,宿主全集不作数。
    pub granted: BTreeSet<CapabilityId>,
    /// 生效预算 = 申请逐维钳入天花板(下限维取较严一侧)。
    pub effective_budget: CommandBudget,
}

/// 扩展宿主:台账 + 命令门控 + 受托管的命令总线。
///
/// 命令状态机(在途/幂等/CAS/终态)仍全部归 [`CommandBus`];本类型只新增
/// 「扩展身份」一轴:谁能提交、提交时能花多少预算、撤销后全部拒之门外。
#[derive(Debug)]
pub struct ExtensionHost<T: BehaviorTarget> {
    pub(super) policy: ExtensionHostPolicy,
    pub(super) records: BTreeMap<String, ExtensionRecord>,
    /// 已撤销 id。安全终态,永不遗忘(量级 = 扩展注册操作次数,非命令流量)。
    pub(super) revoked_ids: BTreeSet<String>,
    /// 扩展 → 经本类型提交且尚未终态确认的 invocation 引用(撤销时逐个取消)。
    pub(super) tracked: BTreeMap<String, BTreeSet<InvocationId>>,
    pub(super) bus: CommandBus<T>,
    pub(super) counters: ExtensionCounters,
}

impl<T: BehaviorTarget> ExtensionHost<T> {
    /// 构造时校验策略形状(与 `N1Adapter::new` 同一纪律),非法即拒,不带病运行。
    pub fn new(policy: ExtensionHostPolicy, bus: CommandBus<T>) -> Result<Self, String> {
        if policy.signing_key.is_empty() {
            return Err("host signing key must be non-empty".into());
        }
        if policy.supported_abi_versions.is_empty() {
            return Err("host must support at least one extension ABI version".into());
        }
        let ceiling = &policy.budget_ceiling;
        // timeout 维是 u64,其余四维是 usize,分开校验。
        for (value, name) in [
            (ceiling.max_in_flight, "budget_ceiling.max_in_flight"),
            (
                ceiling.max_idempotency_keys,
                "budget_ceiling.max_idempotency_keys",
            ),
            (
                ceiling.min_idempotency_key_len,
                "budget_ceiling.min_idempotency_key_len",
            ),
            (
                ceiling.max_cancelled_memory,
                "budget_ceiling.max_cancelled_memory",
            ),
        ] {
            if value == 0 {
                return Err(format!("{name} must be at least 1"));
            }
        }
        if ceiling.max_command_timeout_ms == 0 {
            return Err("budget_ceiling.max_command_timeout_ms must be at least 1".into());
        }
        Ok(Self {
            policy,
            records: BTreeMap::new(),
            revoked_ids: BTreeSet::new(),
            tracked: BTreeMap::new(),
            bus,
            counters: ExtensionCounters::default(),
        })
    }

    pub fn policy(&self) -> &ExtensionHostPolicy {
        &self.policy
    }
    pub fn counters(&self) -> ExtensionCounters {
        self.counters
    }
    pub fn record(&self, extension_id: &str) -> Option<&ExtensionRecord> {
        self.records.get(extension_id)
    }
    pub fn is_revoked(&self, extension_id: &str) -> bool {
        self.revoked_ids.contains(extension_id)
    }
    pub fn bus(&self) -> &CommandBus<T> {
        &self.bus
    }
    pub fn bus_mut(&mut self) -> &mut CommandBus<T> {
        &mut self.bus
    }

    /// 纯探测:不写任何状态,给出假设此刻注册的兼容结论。
    /// 签名一关在探测里不判定(`signature_ok: None`);描述符应先通过形状校验。
    pub fn evaluate(&self, descriptor: &ExtensionDescriptor) -> CompatibilityReport {
        self.compatibility(descriptor, None)
    }

    /// 注册:形状 → 台账前置(撤销/重复) → 签名 → ABI → 能力 → 预算 → 入账。
    /// 台账前置放最前:终态 id 不再消耗验证工作,重复 id 直接可见。
    pub fn register(
        &mut self,
        descriptor: ExtensionDescriptor,
    ) -> Result<CompatibilityReport, RegistrationRejection> {
        if let Some(reason) = validate_descriptor(&descriptor) {
            self.counters.rejected_invalid_descriptor += 1;
            return Err(RegistrationRejection::InvalidDescriptor {
                reason,
                report: Box::new(self.compatibility(&descriptor, Some(false))),
            });
        }
        if self.revoked_ids.contains(&descriptor.id) {
            self.counters.rejected_duplicate += 1;
            return Err(RegistrationRejection::IdRevoked {
                report: Box::new(self.compatibility(&descriptor, None)),
            });
        }
        if self.records.contains_key(&descriptor.id) {
            self.counters.rejected_duplicate += 1;
            return Err(RegistrationRejection::Duplicate {
                report: Box::new(self.compatibility(&descriptor, None)),
            });
        }
        let signature_ok = self.verify_signature(&descriptor);
        let mut report = self.compatibility(&descriptor, Some(signature_ok));
        if !signature_ok {
            self.counters.rejected_signature += 1;
            return Err(RegistrationRejection::SignatureMismatch {
                report: Box::new(report),
            });
        }
        if !report.abi_compatible {
            self.counters.rejected_abi += 1;
            return Err(RegistrationRejection::AbiIncompatible {
                report: Box::new(report),
            });
        }
        if !report.missing_capabilities.is_empty() {
            self.counters.rejected_capabilities += 1;
            return Err(RegistrationRejection::MissingCapabilities {
                report: Box::new(report),
            });
        }
        if !report.budget_deltas.is_empty() {
            self.counters.rejected_budget += 1;
            return Err(RegistrationRejection::BudgetExceeded {
                report: Box::new(report),
            });
        }
        let record = ExtensionRecord {
            granted: descriptor
                .required_capabilities
                .intersection(&self.policy.granted_capabilities)
                .copied()
                .collect(),
            effective_budget: clamp_budget(&descriptor.budget, &self.policy.budget_ceiling),
            descriptor,
        };
        self.records.insert(record.descriptor.id.clone(), record);
        report.accepted = true;
        self.counters.registered += 1;
        Ok(report)
    }

    /// 撤销:移出台账、取消其全部在途引用、记入终态黑名单。
    /// 幂等:重复撤销返回 `AlreadyRevoked`,不重复计数成功。
    pub fn revoke(&mut self, extension_id: &str) -> RevokeOutcome {
        let Some(record) = self.records.remove(extension_id) else {
            self.counters.revoke_missed += 1;
            return if self.revoked_ids.contains(extension_id) {
                RevokeOutcome::AlreadyRevoked
            } else {
                RevokeOutcome::Unknown
            };
        };
        if let Some(invocations) = self.tracked.remove(extension_id) {
            for invocation in invocations {
                if matches!(
                    self.bus.cancel(invocation),
                    crate::behavior_ir::CancelOutcome::Cancelled { .. }
                ) {
                    self.counters.invocations_cancelled_on_revoke += 1;
                }
            }
        }
        self.revoked_ids.insert(record.descriptor.id);
        self.counters.revoked += 1;
        RevokeOutcome::Revoked
    }

    fn verify_signature(&self, descriptor: &ExtensionDescriptor) -> bool {
        let expected = hmac_sha256(&self.policy.signing_key, &signature_payload(descriptor));
        let expected_hex: String = expected.iter().map(|byte| format!("{byte:02x}")).collect();
        expected_hex == descriptor.signature
    }

    fn compatibility(
        &self,
        descriptor: &ExtensionDescriptor,
        signature_ok: Option<bool>,
    ) -> CompatibilityReport {
        let missing_capabilities = descriptor
            .required_capabilities
            .difference(&self.policy.granted_capabilities)
            .copied()
            .collect();
        CompatibilityReport {
            extension_id: descriptor.id.clone(),
            requested_version: descriptor.version,
            requested_abi: descriptor.abi_version,
            host_abi: HOST_EXTENSION_ABI_VERSION,
            supported_abis: self.policy.supported_abi_versions.iter().copied().collect(),
            abi_compatible: self
                .policy
                .supported_abi_versions
                .contains(&descriptor.abi_version),
            missing_capabilities,
            budget_deltas: budget_deltas(&descriptor.budget, &self.policy.budget_ceiling),
            signature_ok,
            accepted: false,
        }
    }
}

/// 形状校验:身份规则、版本下界、签名长度与 hex、预算无零维。
/// 零维预算(如 `max_in_flight == 0`)在申请侧无意义——它不是「不占预算」,
/// 而是「拒绝一切命令」,应作为描述符错误在注册前暴露。
pub(super) fn validate_descriptor(descriptor: &ExtensionDescriptor) -> Option<&'static str> {
    if !valid_extension_id(&descriptor.id) {
        return Some("extension id is not a stable id");
    }
    if descriptor.version == 0 {
        return Some("extension version must be at least 1");
    }
    if descriptor.signature.len() != 64
        || !descriptor
            .signature
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Some("signature must be 64 hex characters");
    }
    let budget = &descriptor.budget;
    for (value, name) in [
        (budget.max_in_flight, "budget.max_in_flight"),
        (budget.max_idempotency_keys, "budget.max_idempotency_keys"),
        (
            budget.min_idempotency_key_len,
            "budget.min_idempotency_key_len",
        ),
        (budget.max_cancelled_memory, "budget.max_cancelled_memory"),
    ] {
        if value == 0 {
            return Some(name);
        }
    }
    if budget.max_command_timeout_ms == 0 {
        return Some("budget.max_command_timeout_ms");
    }
    None
}

/// 预算超差:上限维申请超过天花板,或下限维(`min_idempotency_key_len`)
/// 申请低于天花板(削弱宿主最低标准)。空 = 全维合规。
pub(super) fn budget_deltas(
    requested: &CommandBudget,
    ceiling: &CommandBudget,
) -> Vec<BudgetDelta> {
    let mut deltas = Vec::new();
    let mut push = |dimension: &'static str, requested: u64, ceiling: u64| {
        deltas.push(BudgetDelta {
            dimension,
            requested,
            ceiling,
        });
    };
    if requested.max_in_flight > ceiling.max_in_flight {
        push(
            "max_in_flight",
            requested.max_in_flight as u64,
            ceiling.max_in_flight as u64,
        );
    }
    if requested.max_command_timeout_ms > ceiling.max_command_timeout_ms {
        push(
            "max_command_timeout_ms",
            requested.max_command_timeout_ms,
            ceiling.max_command_timeout_ms,
        );
    }
    if requested.max_idempotency_keys > ceiling.max_idempotency_keys {
        push(
            "max_idempotency_keys",
            requested.max_idempotency_keys as u64,
            ceiling.max_idempotency_keys as u64,
        );
    }
    if requested.min_idempotency_key_len < ceiling.min_idempotency_key_len {
        push(
            "min_idempotency_key_len",
            requested.min_idempotency_key_len as u64,
            ceiling.min_idempotency_key_len as u64,
        );
    }
    if requested.max_cancelled_memory > ceiling.max_cancelled_memory {
        push(
            "max_cancelled_memory",
            requested.max_cancelled_memory as u64,
            ceiling.max_cancelled_memory as u64,
        );
    }
    deltas
}

/// 生效预算:上限维取较紧一侧,下限维取较严一侧。只对已通过 `budget_deltas`
/// 为空的申请调用(注册路径);其他调用点会静默钳制而不是拒绝。
pub(super) fn clamp_budget(requested: &CommandBudget, ceiling: &CommandBudget) -> CommandBudget {
    CommandBudget {
        max_in_flight: requested.max_in_flight.min(ceiling.max_in_flight),
        max_command_timeout_ms: requested
            .max_command_timeout_ms
            .min(ceiling.max_command_timeout_ms),
        max_idempotency_keys: requested
            .max_idempotency_keys
            .min(ceiling.max_idempotency_keys),
        min_idempotency_key_len: requested
            .min_idempotency_key_len
            .max(ceiling.min_idempotency_key_len),
        max_cancelled_memory: requested
            .max_cancelled_memory
            .min(ceiling.max_cancelled_memory),
    }
}
