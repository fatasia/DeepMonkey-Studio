use super::contract::*;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

mod submission;

/// 在途命令的记录。
#[derive(Debug, Clone, PartialEq)]
struct InFlight {
    command: BehaviorCommand,
    submitted_at_ms: u64,
}

/// 命令总线。状态与账目由总线持有;动作语义经 `BehaviorTarget` 注入。
/// 宿主不得复用 invocation ID;终态身份窗口仅提供有界防重,不保证永久去重。
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
    idempotency_order: VecDeque<String>,
    terminal_invocations: BTreeSet<InvocationId>,
    terminal_order: VecDeque<InvocationId>,
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
            idempotency_order: VecDeque::new(),
            terminal_invocations: BTreeSet::new(),
            terminal_order: VecDeque::new(),
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

    /// 结算在途命令:应用载荷并推进 revision。
    ///
    /// 在途期间 revision 被抢先推进时,CAS 不再成立 → 拒绝且**不应用**
    /// (这是「过期命令不得改变新状态」在结算侧的落实)。
    pub fn settle(
        &mut self,
        invocation: InvocationId,
    ) -> Result<BehaviorRevision, SettleRejection> {
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
        let entry = self.in_flight.remove(&invocation).expect("checked above");
        self.remember_terminal(invocation);
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

    /// 按注入时钟判定超时并结算:超时命令出在途且不得再次应用。
    /// 截止时刻仍允许结算;幂等键在超时后仍按记忆预算保留。
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
                let timeout_ms = entry.command.timeout_ms;
                // 超时是终态,防止后续无时钟结算重新应用过期命令。
                self.in_flight.remove(&invocation);
                self.remember_terminal(invocation);
                return Err(SettleRejection::TimedOut {
                    elapsed_ms: elapsed,
                    timeout_ms,
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
            self.remember_terminal(invocation);
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
        self.cancelled_invocations
            .extend(invocations.iter().copied());
        for invocation in &invocations {
            self.remember_terminal(*invocation);
        }
        self.in_flight.clear();
        invocations
    }

    /// 幂等键的有损记忆:容量触顶时遗忘最旧插入的键并计数。
    fn trim_idempotency_memory(&mut self) {
        while self.idempotency.len() > self.budget.max_idempotency_keys {
            let Some(oldest) = self.idempotency_order.pop_front() else {
                break;
            };
            self.idempotency.remove(&oldest);
            self.counters.idempotency_forgotten += 1;
        }
    }

    /// 所有终态共享有损身份窗口,按进入终态的顺序淘汰。
    fn remember_terminal(&mut self, invocation: InvocationId) {
        self.terminal_invocations.insert(invocation);
        self.terminal_order.push_back(invocation);
        while self.terminal_invocations.len() > self.budget.max_cancelled_memory {
            let Some(oldest) = self.terminal_order.pop_front() else {
                break;
            };
            self.terminal_invocations.remove(&oldest);
            if self.cancelled_invocations.remove(&oldest) {
                self.counters.cancel_memory_forgotten += 1;
            }
        }
    }
}
