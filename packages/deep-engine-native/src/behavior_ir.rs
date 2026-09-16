//! P1-21:N0 受限行为 IR 与命令总线。
//!
//! ## 这个模块解决什么
//!
//! 图表之外的行为(例如「点这个按钮 → 切到第 3 页 → 高亮某设备 → 拉取数据」)
//! 需要一个跨端、可审计、可重放的命令通道。既有 `ChartAction` 是**图表专用**的
//! 具体语义;本模块是**通用容器**:它管合同机制(身份、幂等、CAS、取消、能力门控、
//! 预算、可观测),不定义具体动作语义——语义由宿主经 `BehaviorTarget` 注入。
//!
//! ## N0 铁律(本模块存在的理由)
//!
//! **任意 JS / DOM / 任意脚本不得进入此处。** `BehaviorCommand` 是**封闭枚举**:
//! 新增动作必须改这个枚举并显式声明其安全边界,而不是运行时解释一段脚本。
//! 能力缺失时命令被**拒绝**,不做「尽力而为」的降级执行。
//!
//! ## 两阶段提交(为什么必须如此)
//!
//! 任务要求「异步取消」。若 `submit` 即生效,「取消」就只能是事后回滚——那不是取消,
//! 是补偿,且会与已发布状态纠缠。因此拆成两阶段:
//!
//! 1. `submit` —— 校验身份/幂等/CAS/能力/预算,通过后命令进入**在途**(返回 `InvocationId`);
//! 2. `settle` —— 在途命令真正应用到状态;或 `cancel` —— 作废,不得再影响状态。
//!
//! 由此得到几条可测的硬语义:
//! - **幂等**:同幂等键重复 `submit` 被拒(不重复预留);键在 submit 时即消耗,
//!   避免「两次提交都进在途、settle 两次」;
//! - **CAS**:`expected_revision` 落后即拒;settle 时再核对一次,防止在途期间被抢先推进;
//! - **取消**:`settle` 一个已取消的 invocation 必须失败,状态不变;
//! - **预算**:在途数超过上限时新 `submit` 被拒(而不是静默排队);取消释放额度。
//!
//! 时间由调用方以 `now_ms` 注入(与 `chart::data_source` 同一范式),无墙钟、无线程。

use std::collections::{BTreeMap, BTreeSet};

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
    /// 「已取消」记忆容量。用于区分「已取消」与「从未提交」;
    /// 超出后最旧的记录被遗忘(有损),此时该 invocation 会退回 NotInFlight。
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
    UnsupportedSchemaVersion { found: u32 },
    InvalidNodeId { node_id: String },
    InvalidInvocationId { reason: &'static str },
    /// 幂等键已用过:重复投递,不得二次预留。
    DuplicateIdempotencyKey { key: String },
    InvalidIdempotencyKey { reason: &'static str },
    /// 前置 revision 落后:过期命令不得改变新状态。
    StaleRevision {
        expected: BehaviorRevision,
        current: BehaviorRevision,
    },
    /// 宿主未声明所需能力。
    MissingCapability { capability: CapabilityId },
    /// 在途数达上限。
    InFlightBudgetExceeded { in_flight: usize, max: usize },
    /// 命令声明的超时超过宿主允许的上界。
    TimeoutBudgetExceeded { requested_ms: u64, max_ms: u64 },
    /// 载荷本身不合法(例如 NaN/无穷的数值、越界页码)。
    InvalidPayload { reason: &'static str },
    /// 同一 invocation 已在途(身份被复用)。
    DuplicateInvocation { invocation: InvocationId },
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

/// 在途命令的记录。
#[derive(Debug, Clone, PartialEq)]
struct InFlight {
    command: BehaviorCommand,
    submitted_at_ms: u64,
}

/// 命令总线。状态与账目由总线持有;动作语义经 `BehaviorTarget` 注入。
#[derive(Debug, Clone)]
pub struct CommandBus<T: BehaviorTarget> {
    budget: CommandBudget,
    capabilities: HostCapabilities,
    revision: BehaviorRevision,
    target: T,
    in_flight: BTreeMap<InvocationId, InFlight>,
    /// 幂等键 → 首次被接受的 invocation(用于判重与诊断)。
    idempotency: BTreeMap<String, InvocationId>,
    /// 已取消的 invocation 集合。用于把「已取消」与「从未提交」区分开——
    /// 二者都返回 NotInFlight 会让调用方无法判断是否需要告警。
    cancelled_invocations: BTreeSet<InvocationId>,
    counters: CommandCounters,
    next_invocation: u64,
}

impl<T: BehaviorTarget> CommandBus<T> {
    pub fn new(budget: CommandBudget, capabilities: HostCapabilities, target: T) -> Self {
        Self {
            budget,
            capabilities,
            revision: BehaviorRevision(0),
            target,
            in_flight: BTreeMap::new(),
            idempotency: BTreeMap::new(),
            cancelled_invocations: BTreeSet::new(),
            counters: CommandCounters::default(),
            next_invocation: 1,
        }
    }

    pub fn revision(&self) -> BehaviorRevision {
        self.revision
    }
    pub fn in_flight_len(&self) -> usize {
        self.in_flight.len()
    }
    pub fn counters(&self) -> CommandCounters {
        self.counters
    }
    pub fn target(&self) -> &T {
        &self.target
    }
    /// 由宿主状态推进触发:bump 使所有更早的 `expected_revision` 失效(CAS 基准)。
    pub fn bump_revision(&mut self) -> BehaviorRevision {
        self.revision = BehaviorRevision(self.revision.0.saturating_add(1));
        self.revision
    }

    /// 为调用方生成下一个 invocation id(单调、不与既有重复)。
    pub fn next_invocation_id(&mut self) -> InvocationId {
        let id = InvocationId(self.next_invocation);
        self.next_invocation = self.next_invocation.saturating_add(1);
        id
    }

    /// 提交一条命令。通过全部校验后进入**在途**,返回 invocation。
    pub fn submit(
        &mut self,
        command: BehaviorCommand,
        now_ms: u64,
    ) -> Result<InvocationId, SubmitRejection> {
        self.counters.submitted += 1;
        // 顺序固定:结构 → 身份 → 幂等 → CAS → 能力 → 预算 → 载荷。
        // 结构/身份错误最廉价且最能反映调用方 bug,先判;CASC/能力/预算是策略判定,
        // 放在身份之后,使「同一份合法命令在预算紧张时被拒」与「命令本身非法」可分。
        if command.schema_version != BEHAVIOR_IR_SCHEMA_VERSION {
            self.counters.rejected_invalid += 1;
            return Err(SubmitRejection::UnsupportedSchemaVersion {
                found: command.schema_version,
            });
        }
        if !stable_node_id(&command.node_id) {
            self.counters.rejected_invalid += 1;
            return Err(SubmitRejection::InvalidNodeId {
                node_id: command.node_id,
            });
        }
        if command.invocation_id.0 == 0 {
            self.counters.rejected_invalid += 1;
            return Err(SubmitRejection::InvalidInvocationId {
                reason: "invocation id 0 is reserved",
            });
        }
        if self.in_flight.contains_key(&command.invocation_id) {
            self.counters.rejected_invalid += 1;
            return Err(SubmitRejection::DuplicateInvocation {
                invocation: command.invocation_id,
            });
        }
        if command.idempotency_key.len() < self.budget.min_idempotency_key_len {
            self.counters.rejected_invalid += 1;
            return Err(SubmitRejection::InvalidIdempotencyKey {
                reason: "idempotency key shorter than the configured minimum",
            });
        }
        if command.idempotency_key.len() > 256 {
            self.counters.rejected_invalid += 1;
            return Err(SubmitRejection::InvalidIdempotencyKey {
                reason: "idempotency key exceeds 256 bytes",
            });
        }
        if self.idempotency.contains_key(&command.idempotency_key) {
            self.counters.rejected_duplicate_idempotency += 1;
            return Err(SubmitRejection::DuplicateIdempotencyKey {
                key: command.idempotency_key,
            });
        }
        if command.expected_revision != self.revision {
            self.counters.rejected_stale_revision += 1;
            return Err(SubmitRejection::StaleRevision {
                expected: command.expected_revision,
                current: self.revision,
            });
        }
        if let Some(capability) = command.required_capacity
            && !self.capabilities.declares(capability)
        {
            self.counters.rejected_missing_capability += 1;
            return Err(SubmitRejection::MissingCapability { capability });
        }
        if self.in_flight.len() >= self.budget.max_in_flight {
            self.counters.rejected_budget += 1;
            return Err(SubmitRejection::InFlightBudgetExceeded {
                in_flight: self.in_flight.len(),
                max: self.budget.max_in_flight,
            });
        }
        if command.timeout_ms > self.budget.max_command_timeout_ms {
            self.counters.rejected_budget += 1;
            return Err(SubmitRejection::TimeoutBudgetExceeded {
                requested_ms: command.timeout_ms,
                max_ms: self.budget.max_command_timeout_ms,
            });
        }
        if let Err(reason) = validate_payload(&command.payload) {
            self.counters.rejected_invalid += 1;
            return Err(SubmitRejection::InvalidPayload { reason });
        }

        let invocation = command.invocation_id;
        self.idempotency
            .insert(command.idempotency_key.clone(), invocation);
        self.trim_idempotency_memory();
        self.in_flight.insert(
            invocation,
            InFlight {
                command,
                submitted_at_ms: now_ms,
            },
        );
        Ok(invocation)
    }

    /// 结算在途命令:应用载荷并推进 revision。
    ///
    /// 在途期间 revision 被抢先推进时,CAS 不再成立 → 拒绝且**不应用**
    /// (这是「过期命令不得改变新状态」在结算侧的落实)。
    pub fn settle(&mut self, invocation: InvocationId) -> Result<BehaviorRevision, SettleRejection> {
        // 「已取消」优先于「不在途」:二者都无在途记录,但语义不同——
        // 取消是宿主主动作废,不告警;从未提交是调用方 bug,需要可见。
        if self.cancelled_invocations.contains(&invocation) {
            return Err(SettleRejection::Cancelled { invocation });
        }
        let entry = self
            .in_flight
            .get(&invocation)
            .ok_or(SettleRejection::NotInFlight { invocation })?;
        if entry.command.expected_revision != self.revision {
            let expected = entry.command.expected_revision;
            let current = self.revision;
            // 不应用、也不移除:调用方可据原因决定是丢弃还是重试。
            return Err(SettleRejection::RevisionMoved { expected, current });
        }
        let entry = self
            .in_flight
            .remove(&invocation)
            .expect("checked above");
        match self.target.apply(&entry.command.payload) {
            Ok(()) => {
                self.revision = BehaviorRevision(self.revision.0.saturating_add(1));
                self.counters.settled += 1;
                Ok(self.revision)
            }
            Err(reason) => {
                // 应用失败:命令已出在途(不得重复应用),revision 不推进。
                self.counters.apply_failed += 1;
                Err(SettleRejection::ApplyFailed { reason })
            }
        }
    }

    /// 按注入时钟判定超时并结算:超过命令声明的 `timeout_ms` 即拒绝且**不应用**。
    pub fn settle_at(
        &mut self,
        invocation: InvocationId,
        now_ms: u64,
    ) -> Result<BehaviorRevision, SettleRejection> {
        if let Some(entry) = self.in_flight.get(&invocation)
            && entry.command.timeout_ms > 0
        {
            let elapsed = now_ms.saturating_sub(entry.submitted_at_ms);
            if elapsed > entry.command.timeout_ms {
                return Err(SettleRejection::TimedOut {
                    elapsed_ms: elapsed,
                    timeout_ms: entry.command.timeout_ms,
                });
            }
        }
        self.settle(invocation)
    }

    /// 取消在途命令。幂等:重复取消返回 `NotInFlight` 而不是错误。
    pub fn cancel(&mut self, invocation: InvocationId) -> CancelOutcome {
        self.counters.cancel_requested += 1;
        if self.in_flight.remove(&invocation).is_some() {
            // 记入「已取消」集合:settle 时据此返回 Cancelled 而不是 NotInFlight。
            self.cancelled_invocations.insert(invocation);
            self.trim_cancelled_memory();
            self.counters.cancelled += 1;
            CancelOutcome::Cancelled { invocation }
        } else {
            self.counters.cancel_missed += 1;
            CancelOutcome::NotInFlight { invocation }
        }
    }

    /// 批量取消(例如切页/换场景时作废全部在途)。返回被取消的 invocation 列表。
    ///
    /// 计数口径与逐条 `cancel` 一致:每条在途各算一次「请求」与一次「成功」,
    /// 使两条路径的账目可对齐比较。
    pub fn cancel_all(&mut self) -> Vec<InvocationId> {
        let invocations = self.in_flight.keys().copied().collect::<Vec<_>>();
        let count = invocations.len() as u64;
        self.counters.cancel_requested += count;
        self.counters.cancelled += count;
        self.cancelled_invocations.extend(invocations.iter().copied());
        self.trim_cancelled_memory();
        self.in_flight.clear();
        invocations
    }

    /// 幂等键的有损记忆:容量触顶时遗忘最旧插入的键并计数。
    fn trim_idempotency_memory(&mut self) {
        while self.idempotency.len() > self.budget.max_idempotency_keys {
            let Some(oldest) = self.idempotency.keys().next().cloned() else {
                break;
            };
            self.idempotency.remove(&oldest);
            self.counters.idempotency_forgotten += 1;
        }
    }

    /// 「已取消」记忆同样有界:超出后遗忘**最小**的 invocation(最旧)。
    fn trim_cancelled_memory(&mut self) {
        while self.cancelled_invocations.len() > self.budget.max_cancelled_memory {
            let Some(oldest) = self.cancelled_invocations.iter().next().copied() else {
                break;
            };
            self.cancelled_invocations.remove(&oldest);
            self.counters.cancel_memory_forgotten += 1;
        }
    }
}

/// 载荷自身的合法性:数值有限、页码在界、id 形状正确。
fn validate_payload(payload: &BehaviorPayload) -> Result<(), &'static str> {
    match payload {
        BehaviorPayload::SetProperty {
            node_id,
            value,
            property: _,
        } => {
            require_node(node_id)?;
            match value {
                Scalar::Number(number) => {
                    if !number.is_finite() {
                        return Err("property number must be finite");
                    }
                    Ok(())
                }
                Scalar::Bool(_) | Scalar::Index(_) => Ok(()),
            }
        }
        BehaviorPayload::SetVisible { node_id, .. } | BehaviorPayload::Focus { node_id } => {
            require_node(node_id)
        }
        BehaviorPayload::Select { node_id, .. } => require_node(node_id),
        BehaviorPayload::ClearSelection => Ok(()),
        BehaviorPayload::SetPage { node_id, page } => {
            require_node(node_id)?;
            if *page > 65_535 {
                return Err("page index out of range");
            }
            Ok(())
        }
        BehaviorPayload::RequestData { dataset_id, .. } => require_node(dataset_id),
        BehaviorPayload::CancelTask { task_id } => require_node(task_id),
    }
}

fn require_node(value: &str) -> Result<(), &'static str> {
    if stable_node_id(value) {
        Ok(())
    } else {
        Err("identity is not a stable id")
    }
}

#[cfg(test)]
#[path = "behavior_ir_tests.rs"]
mod tests;