//! P1-22:统一固定步回放器。
//!
//! ## 这个模块解决什么
//!
//! P1-12 把 sim 固定在了 fixture 时钟上;本模块把**同一纪律**扩展到一段回放
//! 脚本的全部维度:sim tick(经 `ChartSimulationSource` 的 prepare/commit)、
//! 行为命令(经 `CommandBus` 的 submit/settle 两阶段)、输入事件(经
//! `ChartRuntime::dispatch` 的 `ChartAction` 路径)与随机种子(注入式
//! splitmix64,禁止真实熵源)。每步产出命令序列记录、状态轨迹摘要与一个
//! 确定性 display hash(复用 `shader_package::hash_canonical` 的 canonical
//! JSON + SHA-256);**同一脚本重放两次,序列/轨迹/hash 逐字节一致**是核心验收。
//!
//! ## 合同要点
//!
//! - **时间全部注入**:每步的时钟读数由脚本显式声明(`SimTick.elapsed_ms`),
//!   回放器不读墙钟、不起线程、不做真实 IO。
//! - **过期命令拒绝**:预期 revision 不符的命令在 `submit` 处被 CAS 拒绝;
//!   在途期间 revision 被抢先推进的命令在 `settle` 处被拒。拒绝**不推进**
//!   任何状态、不污染轨迹——该步摘要与上一步逐字段一致。
//! - **不复制既有抽象**:`SimSource`、`CommandBus`、`ChartAction`、
//!   `ChartRuntime` 全部直接复用;回放器只做编排与记录。
//! - **取消即终态**:`CancelSim` 之后的 sim tick 不再产出(复用 SimSource
//!   cancel 语义),重复取消幂等。

pub mod target;
mod trace;

use crate::behavior_ir::{
    BEHAVIOR_IR_SCHEMA_VERSION, BehaviorCommand, BehaviorPayload, BehaviorRevision, CommandBudget,
    CommandBus, HostCapabilities, InvocationId,
};
use crate::chart::simulation::{ChartSimFixture, ChartSimulationSource};
use crate::chart::{ChartAction, ChartRuntime};
use crate::shader_package::hash::hash_canonical;
use std::collections::BTreeMap;
pub use target::{ReplayRng, ReplayTarget, SceneCell};
/// 记录类型对外路径保持在 `replay::` 下。
pub use trace::{
    ReplayTrace, StateDigest, StepKind, StepOutcome, StepRecord, TargetDigest, TooltipDigest,
};
use trace::{describe_settle, describe_submit};

/// 回放命令统一的宿主侧身份与墙钟上界:身份恒定,超时预算由 `CommandBudget`
/// 在提交时把关(把 budget 收紧即可测出 `TimeoutBudgetExceeded`)。
const REPLAY_NODE_ID: &str = "replay.host";
const REPLAY_TIMEOUT_MS: u64 = 1_000;
/// 单步随机抽取上限:回放脚本是可信输入,但抽签数必须封顶,防脚本炸弹拖死驱动。
const MAX_RANDOM_DRAWS: u32 = 4_096;

/// 一条回放脚本条目(封闭枚举,N0 风格:不解释脚本,只执行声明的意图)。
#[derive(Debug, Clone, PartialEq)]
pub enum ScriptEntry {
    /// 推进固定步时钟并尝试提交一个 sim tick;`elapsed_ms` 是注入的宿主时钟读数。
    SimTick { elapsed_ms: u64 },
    /// 提交并立即结算一条行为命令(CAS 基准由脚本显式给出,可故意过期)。
    Command {
        expected_revision: u64,
        key: String,
        payload: BehaviorPayload,
    },
    /// 只提交不结算,把 invocation 存入指定槽位,供后续 `Settle` 延迟结算。
    Stage {
        slot: usize,
        expected_revision: u64,
        key: String,
        payload: BehaviorPayload,
    },
    /// 结算槽位中的在途命令;槽位为空即拒绝。
    Settle { slot: usize },
    /// 输入事件:走既有 `ChartAction` dispatch 路径(与运行期同一条路)。
    Input { action: ChartAction },
    /// 消费 n 个种子化随机数并记录进轨迹。
    Random { draws: u32 },
    /// 取消 sim 源(终态):之后的 sim tick 不再产出。
    CancelSim,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayScript {
    pub entries: Vec<ScriptEntry>,
}

impl ReplayScript {
    pub fn new(entries: Vec<ScriptEntry>) -> Self {
        Self { entries }
    }
}

/// 统一固定步回放宿主:拥有 chart、sim 源、命令总线与 RNG。
/// 全部时间由脚本注入,构造后不接触任何真实时钟或 IO。
pub struct ReplayHost {
    chart: ChartRuntime,
    sim: ChartSimulationSource,
    bus: CommandBus<ReplayTarget>,
    rng: ReplayRng,
    /// 延迟结算槽位:写入后不再改动,保证 `Settle` 语义可重放。
    slots: BTreeMap<usize, InvocationId>,
    now_ms: u64,
    sim_committed_ticks: u64,
}

impl ReplayHost {
    pub fn new(
        chart: ChartRuntime,
        fixture: ChartSimFixture,
        budget: CommandBudget,
        capabilities: HostCapabilities,
        seed: u64,
    ) -> Result<Self, String> {
        let sim = ChartSimulationSource::new(fixture, &chart)?;
        Ok(Self {
            chart,
            sim,
            bus: CommandBus::new(budget, capabilities, ReplayTarget::default()),
            rng: ReplayRng::new(seed),
            slots: BTreeMap::new(),
            now_ms: 0,
            sim_committed_ticks: 0,
        })
    }

    /// 执行整段脚本,产出完整轨迹。步序即脚本序,无任何隐藏推进。
    pub fn run(&mut self, script: &ReplayScript) -> ReplayTrace {
        let mut steps = Vec::with_capacity(script.entries.len());
        for (step, entry) in script.entries.iter().enumerate() {
            let (kind, outcome) = match entry {
                ScriptEntry::SimTick { elapsed_ms } => {
                    (StepKind::SimTick, self.step_sim_tick(*elapsed_ms))
                }
                ScriptEntry::Command {
                    expected_revision,
                    key,
                    payload,
                } => (
                    StepKind::Command,
                    self.step_command(*expected_revision, key, payload.clone()),
                ),
                ScriptEntry::Stage {
                    slot,
                    expected_revision,
                    key,
                    payload,
                } => (
                    StepKind::Stage,
                    self.step_stage(*slot, *expected_revision, key, payload.clone()),
                ),
                ScriptEntry::Settle { slot } => (StepKind::Settle, self.step_settle(*slot)),
                ScriptEntry::Input { action } => (StepKind::Input, self.step_input(action.clone())),
                ScriptEntry::Random { draws } => (StepKind::Random, self.step_random(*draws)),
                ScriptEntry::CancelSim => (StepKind::CancelSim, self.step_cancel_sim()),
            };
            let digest = self.capture_digest();
            let display_hash = hash_canonical(
                &serde_json::to_value(&digest).expect("digest is JSON-serializable"),
            );
            steps.push(StepRecord {
                step,
                kind,
                outcome,
                digest,
                display_hash,
            });
        }
        ReplayTrace { steps }
    }

    /// sim tick 的 prepare → 候选应用 → commit 与生产 pump 同序:
    /// 任何失败路径都不触碰 commit,游标原地保持。
    fn step_sim_tick(&mut self, elapsed_ms: u64) -> StepOutcome {
        self.now_ms = elapsed_ms;
        if self.sim.is_cancelled() {
            // 取消即终态:与「未到期」是两种合同,尾部产出必须显式区分。
            return StepOutcome::NoOutput;
        }
        let revision = self.chart.data_revision();
        let frame = match self.sim.prepare(elapsed_ms, revision) {
            Err(error) => {
                return StepOutcome::Rejected {
                    reason: format!("sim prepare failed: {error}"),
                };
            }
            Ok(None) => return StepOutcome::Idle,
            Ok(Some(frame)) => frame,
        };
        let captured_at_ms = frame.captured_at_ms;
        let tick = self.sim_committed_ticks;
        let message = frame.message().clone();
        if let Err(error) = self.chart.apply_data_message(message) {
            return StepOutcome::Rejected {
                reason: format!("sim candidate rejected: {error}"),
            };
        }
        if let Err(error) = self.sim.commit(frame, self.chart.data_revision()) {
            return StepOutcome::Rejected {
                reason: format!("sim commit failed: {error}"),
            };
        }
        self.sim_committed_ticks += 1;
        StepOutcome::Committed {
            tick,
            captured_at_ms,
        }
    }

    fn build_command(
        &mut self,
        expected_revision: u64,
        key: &str,
        payload: BehaviorPayload,
    ) -> BehaviorCommand {
        BehaviorCommand {
            schema_version: BEHAVIOR_IR_SCHEMA_VERSION,
            node_id: REPLAY_NODE_ID.into(),
            invocation_id: self.bus.next_invocation_id(),
            expected_revision: BehaviorRevision(expected_revision),
            idempotency_key: key.into(),
            required_capacity: None,
            payload,
            timeout_ms: REPLAY_TIMEOUT_MS,
        }
    }

    fn step_command(
        &mut self,
        expected_revision: u64,
        key: &str,
        payload: BehaviorPayload,
    ) -> StepOutcome {
        let command = self.build_command(expected_revision, key, payload);
        let now_ms = self.now_ms;
        match self.bus.submit(command, now_ms) {
            Err(rejection) => StepOutcome::Rejected {
                reason: describe_submit(&rejection),
            },
            Ok(invocation) => match self.bus.settle(invocation) {
                Err(rejection) => StepOutcome::Rejected {
                    reason: describe_settle(&rejection),
                },
                Ok(revision) => StepOutcome::Settled {
                    revision: revision.0,
                },
            },
        }
    }

    fn step_stage(
        &mut self,
        slot: usize,
        expected_revision: u64,
        key: &str,
        payload: BehaviorPayload,
    ) -> StepOutcome {
        if self.slots.contains_key(&slot) {
            // 槽位写入后不再改动:覆盖会让旧 invocation 静默滞留在途,双跑无法对账。
            return StepOutcome::Rejected {
                reason: format!("stage rejected: slot {slot} already holds a staged invocation"),
            };
        }
        let command = self.build_command(expected_revision, key, payload);
        match self.bus.submit(command, self.now_ms) {
            Err(rejection) => StepOutcome::Rejected {
                reason: describe_submit(&rejection),
            },
            Ok(invocation) => {
                self.slots.insert(slot, invocation);
                StepOutcome::Staged {
                    invocation: invocation.0,
                }
            }
        }
    }

    fn step_settle(&mut self, slot: usize) -> StepOutcome {
        let Some(&invocation) = self.slots.get(&slot) else {
            return StepOutcome::Rejected {
                reason: format!("settle rejected: slot {slot} has no staged invocation"),
            };
        };
        match self.bus.settle(invocation) {
            Err(rejection) => StepOutcome::Rejected {
                reason: describe_settle(&rejection),
            },
            Ok(revision) => StepOutcome::Settled {
                revision: revision.0,
            },
        }
    }

    fn step_input(&mut self, action: ChartAction) -> StepOutcome {
        match self.chart.dispatch(action) {
            Err(error) => StepOutcome::Rejected {
                reason: format!("input rejected: {error}"),
            },
            Ok(changed) => StepOutcome::Applied { changed },
        }
    }

    fn step_random(&mut self, draws: u32) -> StepOutcome {
        if draws > MAX_RANDOM_DRAWS {
            return StepOutcome::Rejected {
                reason: format!("random rejected: {draws} draws exceed the per-step budget"),
            };
        }
        StepOutcome::Drawn {
            values: (0..draws).map(|_| self.rng.next_u64()).collect(),
        }
    }

    fn step_cancel_sim(&mut self) -> StepOutcome {
        if !self.sim.is_cancelled() {
            self.sim.cancel();
        }
        StepOutcome::Cancelled
    }

    /// 汇总 chart 交互/数据、sim 游标、总线账目、目标场景与 RNG 的全量摘要。
    fn capture_digest(&self) -> StateDigest {
        let state = self.chart.state();
        let ir = self.chart.source();
        let dataset = ir.datasets.iter().find(|d| d.id == "main");
        let emphasis = &state.emphasis;
        let emphasis_series = ir
            .series
            .iter()
            .filter(|series| emphasis.contains_entire_series(&series.id))
            .map(|series| series.id.clone())
            .collect();
        // 整系列之外的例外强调:逐系列对现有数据行求 contains。
        let emphasis_cells = ir
            .series
            .iter()
            .filter_map(|series| {
                let dataset = ir.datasets.iter().find(|d| d.id == series.dataset_id)?;
                Some(
                    (0..dataset.rows.len())
                        .filter(|index| emphasis.contains(&series.id, *index))
                        .map(|index| (series.id.clone(), index))
                        .collect::<Vec<_>>(),
                )
            })
            .flatten()
            .collect();
        StateDigest {
            now_ms: self.now_ms,
            sim_committed_ticks: self.sim_committed_ticks,
            sim_cancelled: self.sim.is_cancelled(),
            sim_due_ms: self.sim.next_due_ms().ok(),
            chart_data_revision: self.chart.data_revision(),
            chart_revision: self.chart.revision(),
            bus_revision: self.bus.revision().0,
            bus_in_flight: self.bus.in_flight_len(),
            hidden_series: state.hidden_series.clone(),
            highlighted: state.highlighted.clone(),
            selected: state.selected.clone(),
            zoom_windows: state.zoom_windows.clone(),
            tooltip: state.tooltip.as_ref().map(|tooltip| TooltipDigest {
                series_id: tooltip.series_id.clone(),
                data_index: tooltip.data_index,
                x_value: tooltip.x_value.clone(),
                y_value: tooltip.y_value.clone(),
            }),
            emphasis_series,
            emphasis_cells,
            last_row: dataset.and_then(|d| d.rows.last()).cloned(),
            row_count: dataset.map_or(0, |d| d.rows.len()),
            target: TargetDigest {
                scene: self.bus.target().scene().clone(),
                selection: self.bus.target().selection().iter().cloned().collect(),
                focused: self.bus.target().focused().map(str::to_string),
                data_requests: self.bus.target().data_requests(),
                cancelled_tasks: self.bus.target().cancelled_tasks(),
            },
            rng_state: self.rng.state(),
        }
    }
}

/// 提交与结算拒绝的人话描述见 [`trace::describe_submit`] / [`trace::describe_settle`]。
#[cfg(test)]
#[path = "replay_tests.rs"]
mod tests;
