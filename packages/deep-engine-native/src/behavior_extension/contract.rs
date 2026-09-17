//! P3-03 扩展合同:描述符、宿主策略、兼容报告、拒绝原因、可观测计数。
//!
//! 合同先行:本文件只定义数据形状与判定规则,状态与流程在 [`super::registry`]
//! (注册/撤销台账)与 [`super::gate`](命令门控)。全部判定 fail-closed:
//! 任一关不过即拒绝,绝不降级执行——与 behavior_ir 的 N0 铁律同源。

use crate::behavior_ir::{CapabilityId, CommandBudget};
use std::collections::BTreeSet;

/// 扩展 ABI 的宿主当前版本。描述符声明的 `abi_version` 不在宿主支持集内即拒绝,
/// 不做就近降级(降级执行是静默错配的温床)。
pub const HOST_EXTENSION_ABI_VERSION: u32 = 1;

/// 扩展身份。复用 behavior_ir 的 `stable_node_id` 规则:非空、≤128 字节、
/// 仅 ASCII 字母数字与 `._:-`,使扩展身份与命令节点身份同族、同样防路径注入。
pub fn valid_extension_id(value: &str) -> bool {
    crate::behavior_ir::stable_node_id(value)
}

/// 扩展描述符:注册的完整申请单,签名覆盖除自身外的全部字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionDescriptor {
    pub id: String,
    /// 扩展自身版本,从 1 起;0 视为非法描述符。
    pub version: u32,
    /// 扩展编译针对的 ABI 版本;协商见 `CompatibilityReport`。
    pub abi_version: u32,
    /// 扩展申请的宿主能力集;注册成功的授权 = 申请集 ∩ 宿主愿授集(不是全集)。
    pub required_capabilities: BTreeSet<CapabilityId>,
    /// 扩展申请的命令预算(与宿主总线同一结构);生效份额 = 逐维钳入宿主上限。
    pub budget: CommandBudget,
    /// 发布方 HMAC-SHA256 hex(64 字符),覆盖上述全部字段。
    pub signature: String,
}

/// 宿主侧注册策略:签名密钥、ABI 支持集、能力授予上限、预算天花板、跟踪容量。
#[derive(Debug, Clone)]
pub struct ExtensionHostPolicy {
    /// HMAC 密钥(宿主与发布方共享)。空密钥在构造时被拒。
    pub signing_key: Vec<u8>,
    /// 宿主支持的扩展 ABI 版本集;空集在构造时被拒(没有可运行 ABI 就不该开门)。
    pub supported_abi_versions: BTreeSet<u32>,
    /// 宿主愿意授予扩展的能力上限;申请集超出此集的部分即缺失权限。
    pub granted_capabilities: BTreeSet<CapabilityId>,
    /// 预算天花板。`max_*` 维:申请 > 上限即超差;`min_idempotency_key_len`
    /// 是下限维:申请 < 天花板即削弱宿主最低标准,同样记为超差。
    /// 钳制后的生效预算同时是门控的份额依据(在途跟踪容量即生效 `max_in_flight`)。
    pub budget_ceiling: CommandBudget,
}

/// 预算差额:一维上的(申请值, 天花板值)。方向由维度语义决定,报告不重复解释。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetDelta {
    pub dimension: &'static str,
    pub requested: u64,
    pub ceiling: u64,
}

/// 兼容报告:注册管线每一关的结论文本化。可独立探测(`evaluate`),
/// 也在每个注册拒绝中随行,使「为什么被拒」永远有结构化答案。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatibilityReport {
    pub extension_id: String,
    pub requested_version: u32,
    pub requested_abi: u32,
    pub host_abi: u32,
    pub supported_abis: Vec<u32>,
    pub abi_compatible: bool,
    pub missing_capabilities: Vec<CapabilityId>,
    pub budget_deltas: Vec<BudgetDelta>,
    pub signature_ok: Option<bool>,
    /// 四关全过(仅 `register` 的成功路径为 true)。
    pub accepted: bool,
}

/// 注册拒绝。每个变体对应一条可测合同;`report` 始终随行(签名失败时
/// ABI/能力/预算各关仍给出评估,供发布方自诊断)。报告走 Box:拒绝是冷路径,
/// 保持 Result 小体积(clippy::result_large_err),可读性不受影响。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationRejection {
    /// 描述符本身非法(id 形状、version 0、签名长度、预算零维)。
    InvalidDescriptor {
        reason: &'static str,
        report: Box<CompatibilityReport>,
    },
    /// 签名验证不过。fail-closed:与「缺签名」同罪,不区分篡改方向。
    SignatureMismatch { report: Box<CompatibilityReport> },
    /// ABI 协商失败:声明的 ABI 不在宿主支持集。
    AbiIncompatible { report: Box<CompatibilityReport> },
    /// 能力门控:申请集中宿主不愿授的能力(非空)。
    MissingCapabilities { report: Box<CompatibilityReport> },
    /// 预算预留失败:至少一维超差(差额见 report.budget_deltas)。
    BudgetExceeded { report: Box<CompatibilityReport> },
    /// 该 id 曾被撤销。撤销是终态,同 id 永不复活;升级换 id 是发布方纪律。
    IdRevoked { report: Box<CompatibilityReport> },
    /// 同 id 已在册(本切片不做在册升级)。
    Duplicate { report: Box<CompatibilityReport> },
}

impl RegistrationRejection {
    pub fn report(&self) -> &CompatibilityReport {
        match self {
            Self::InvalidDescriptor { report, .. }
            | Self::SignatureMismatch { report }
            | Self::AbiIncompatible { report }
            | Self::MissingCapabilities { report }
            | Self::BudgetExceeded { report }
            | Self::IdRevoked { report }
            | Self::Duplicate { report } => report,
        }
    }
}

/// 撤销结果。幂等:对已撤销 id 的二次撤销是 `AlreadyRevoked`,不是错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeOutcome {
    Revoked,
    AlreadyRevoked,
    /// 从未注册。与「已撤销」区分开:前者多半是调用方 bug,需要可见。
    Unknown,
}

/// 命令门控拒绝。发生在把命令移交 `CommandBus` 之前;总线自身的拒绝
/// (`SubmitRejection`)原样透传,不在这里重新包装。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtensionSubmitRejection {
    /// 扩展不在台账。
    NotRegistered { extension_id: String },
    /// 扩展已撤销:其全部命令(含重新注册前的重放)被拒。
    Revoked { extension_id: String },
    /// 命令要求的能力不在该扩展的授权集内(哪怕宿主整体声明了该能力)。
    CapabilityNotGranted { capability: CapabilityId },
    /// 命令超时超过该扩展的生效预算份额。
    ExtensionTimeoutExceeded { requested_ms: u64, allowed_ms: u64 },
    /// 该扩展的在途引用跟踪已满;宿主应对终态 invocation 调用 `release`。
    ExtensionInFlightExhausted { extension_id: String, max: usize },
    /// 总线拒绝(身份/幂等/CAS/全局预算/载荷),原因见内层。
    BusRejected(crate::behavior_ir::SubmitRejection),
}

impl From<crate::behavior_ir::SubmitRejection> for ExtensionSubmitRejection {
    fn from(rejection: crate::behavior_ir::SubmitRejection) -> Self {
        Self::BusRejected(rejection)
    }
}

/// 门控可观测计数(与 `CommandCounters` 同族:逐拒绝原因一个槽位)。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ExtensionCounters {
    pub registered: u64,
    pub revoked: u64,
    pub revoke_missed: u64,
    pub rejected_invalid_descriptor: u64,
    pub rejected_signature: u64,
    pub rejected_abi: u64,
    pub rejected_capabilities: u64,
    pub rejected_budget: u64,
    pub rejected_duplicate: u64,
    pub submit_accepted: u64,
    pub submit_rejected_extension: u64,
    pub submit_rejected_bus: u64,
    pub invocations_cancelled_on_revoke: u64,
}
