use std::collections::BTreeSet;

/// 行为 IR 的 schema 版本;结构变化时递增,消费方据此拒绝未知版本。
pub const BEHAVIOR_IR_SCHEMA_VERSION: u32 = 1;

/// 稳定节点身份。校验规则与既有稳定 id 一致:非空、有界、仅 ASCII 字母数字与
/// `._:-`——**不允许**空格/引号/路径分隔符,避免身份被当成路径或注入片段。
pub fn stable_node_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

/// 调用身份:每次提交唯一,用于取消与迟到丢弃。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InvocationId(pub u64);

/// 状态 revision:CAS 的比较基准。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BehaviorRevision(pub u64);

/// 宿主能力标识(小整数字典序,便于稳定排序与跨语言比对)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapabilityId(pub u16);

/// 宿主能力声明。命令要求的任一能力不在其中即被拒绝——**不做降级执行**。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostCapabilities {
    declared: BTreeSet<CapabilityId>,
}

impl HostCapabilities {
    pub fn new(declared: impl IntoIterator<Item = CapabilityId>) -> Self {
        Self {
            declared: declared.into_iter().collect(),
        }
    }
    pub fn declares(&self, capability: CapabilityId) -> bool {
        self.declared.contains(&capability)
    }
    pub fn len(&self) -> usize {
        self.declared.len()
    }
    pub fn is_empty(&self) -> bool {
        self.declared.is_empty()
    }
}

/// N0 受限命令子集。
///
/// 每一项都是**宿主可完整校验**的结构化意图,不含表达式、不含脚本、不含自定义载荷:
/// - `SetProperty` —— 设置节点的一个具名标量属性;
/// - `SetVisible` —— 显隐;
/// - `Select` / `ClearSelection` —— 选择意图;
/// - `SetPage` —— 切页;
/// - `Focus` —— 焦点意图;
/// - `RequestData` —— 请求一个具名数据集(实际 IO 归宿主数据源,P1-13);
/// - `Cancel` —— 取消一个具名在途任务。
///
/// 属性值用**闭合的标量类型**而不是 `serde_json::Value`:开放 JSON 会变成
/// 「用数据当脚本」的后门,与 N0 铁律冲突。
#[derive(Debug, Clone, PartialEq)]
pub enum BehaviorPayload {
    SetProperty {
        node_id: String,
        property: BehaviorProperty,
        value: Scalar,
    },
    SetVisible {
        node_id: String,
        visible: bool,
    },
    Select {
        node_id: String,
        additive: bool,
    },
    ClearSelection,
    SetPage {
        node_id: String,
        page: u32,
    },
    Focus {
        node_id: String,
    },
    RequestData {
        dataset_id: String,
        /// 期望的源版本;`None` 表示「取最新」。
        expected_source_version: Option<u64>,
    },
    CancelTask {
        task_id: String,
    },
}

/// 可设置的属性名:封闭枚举,不是任意字符串。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BehaviorProperty {
    Opacity,
    Rotation,
    Scale,
    Tint,
}

/// 闭合的标量类型。刻意不含字符串与嵌套结构:字符串会是「用数据当代码」的入口。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scalar {
    Number(f64),
    Bool(bool),
    /// 索引型整数(页号、通道号)。
    Index(u32),
}

/// 一条完整命令:身份 + 前置条件 + 载荷。
#[derive(Debug, Clone, PartialEq)]
pub struct BehaviorCommand {
    pub schema_version: u32,
    pub node_id: String,
    pub invocation_id: InvocationId,
    pub expected_revision: BehaviorRevision,
    /// 幂等键:同键的重复投递只允许生效一次。
    pub idempotency_key: String,
    /// 该命令需要宿主声明的能力。
    pub required_capacity: Option<CapabilityId>,
    pub payload: BehaviorPayload,
    /// 宿主预算:命令允许占用的墙钟毫秒上界(0 表示不设)。超时由宿主按注入时钟判定。
    pub timeout_ms: u64,
}

/// 命令总线预算。全部为**硬上限**:触界即拒绝,不静默排队或丢弃。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandBudget {
    /// 同时允许的在途命令数。
    pub max_in_flight: usize,
    /// 单条命令的墙钟上界(毫秒);命令自身声明不得超过它。
    pub max_command_timeout_ms: u64,
    /// 幂等键记忆容量;超出后最旧的键被遗忘(有损记忆,计入计数)。
    pub max_idempotency_keys: usize,
    /// 幂等键最小长度(防「空键/占位键」被当成幂等凭据)。
    pub min_idempotency_key_len: usize,
    /// 终态身份记忆容量(保留字段名兼容调用方):取消、超时、成功及应用失败共享。
    /// 超出后按终态发生顺序遗忘;被遗忘的取消记录退回 NotInFlight。
    /// 此窗口不保证永久去重,宿主在窗口之外也不得复用 invocation ID。
    pub max_cancelled_memory: usize,
}

impl Default for CommandBudget {
    fn default() -> Self {
        Self {
            max_in_flight: 64,
            max_command_timeout_ms: 30_000,
            max_idempotency_keys: 4_096,
            min_idempotency_key_len: 8,
            max_cancelled_memory: 4_096,
        }
    }
}

/// 提交被拒的原因。每个原因对应一条**可测的合同**,不是泛化错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitRejection {
    UnsupportedSchemaVersion {
        found: u32,
    },
    InvalidNodeId {
        node_id: String,
    },
    InvalidInvocationId {
        reason: &'static str,
    },
    /// 幂等键已用过:重复投递,不得二次预留。
    DuplicateIdempotencyKey {
        key: String,
    },
    InvalidIdempotencyKey {
        reason: &'static str,
    },
    /// 前置 revision 落后:过期命令不得改变新状态。
    StaleRevision {
        expected: BehaviorRevision,
        current: BehaviorRevision,
    },
    /// 宿主未声明所需能力。
    MissingCapability {
        capability: CapabilityId,
    },
    /// 在途数达上限。
    InFlightBudgetExceeded {
        in_flight: usize,
        max: usize,
    },
    /// 命令声明的超时超过宿主允许的上界。
    TimeoutBudgetExceeded {
        requested_ms: u64,
        max_ms: u64,
    },
    /// 载荷本身不合法(例如 NaN/无穷的数值、越界页码)。
    InvalidPayload {
        reason: &'static str,
    },
    /// 同一 invocation 已在途或仍在终态记忆中(身份被复用)。
    DuplicateInvocation {
        invocation: InvocationId,
    },
}

/// 结算被拒的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleRejection {
    /// invocation 不在途(未提交、已结算或已取消)。
    NotInFlight { invocation: InvocationId },
    /// 已取消:不得再影响状态。
    Cancelled { invocation: InvocationId },
    /// 在途期间 revision 被抢先推进,CAS 不再成立。
    RevisionMoved {
        expected: BehaviorRevision,
        current: BehaviorRevision,
    },
    /// 超时:按注入时钟判定已过期。
    TimedOut { elapsed_ms: u64, timeout_ms: u64 },
    /// 目标拒绝应用(载荷语义不被宿主支持)。命令已出在途,不得重复应用。
    ApplyFailed { reason: String },
}

/// 取消结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    /// 成功取消一个在途命令。
    Cancelled { invocation: InvocationId },
    /// 该 invocation 不在途(幂等:重复取消返回此值而不是错误)。
    NotInFlight { invocation: InvocationId },
}

/// 命令的应用目标:由宿主注入具体语义。
///
/// 总线的职责是**合同**(身份/幂等/CAS/取消/能力/预算),不是动作语义。
/// 拒绝返回原因字符串,使应用失败可观测,同时总线仍然掌握状态与账目。
pub trait BehaviorTarget {
    fn apply(&mut self, payload: &BehaviorPayload) -> Result<(), String>;
}

/// 可观测计数器(与 `chart::data_source::DataSourceCounters` 同族风格)。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CommandCounters {
    pub submitted: u64,
    pub settled: u64,
    pub apply_failed: u64,
    pub cancel_requested: u64,
    pub cancelled: u64,
    pub cancel_missed: u64,
    pub rejected_stale_revision: u64,
    pub rejected_duplicate_idempotency: u64,
    pub rejected_missing_capability: u64,
    pub rejected_budget: u64,
    pub rejected_invalid: u64,
    /// 幂等键记忆因容量触及而被遗忘的最旧键数(有损记忆)。
    pub idempotency_forgotten: u64,
    /// 「已取消」记忆因容量触及而被遗忘的最旧记录数(有损记忆)。
    pub cancel_memory_forgotten: u64,
}
