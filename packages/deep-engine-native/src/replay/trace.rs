//! 回放轨迹记录:命令序列、状态摘要与拒绝文案。
//!
//! 本模块只定义**可序列化的记录类型**与拒绝的人话描述;执行编排在
//! `super::ReplayHost`。记录是双跑逐字节比较的载体,全部字段确定性派生,
//! f64 只出现在被校验过的合法值上(无 NaN)。

use crate::behavior_ir::{SettleRejection, SubmitRejection};
use crate::replay::target::SceneCell;
use serde::Serialize;
use std::collections::BTreeMap;

/// 步骤类别,与 `ScriptEntry` 一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum StepKind {
    SimTick,
    Command,
    Stage,
    Settle,
    Input,
    Random,
    CancelSim,
}

/// 单步结果:命令序列记录的载体。拒绝原因给人话 + 关键数值,可审计可比较。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum StepOutcome {
    /// sim tick 已提交:tick 序号与该帧时间戳。
    Committed { tick: u64, captured_at_ms: u64 },
    /// sim 未到期,游标保持原位。
    Idle,
    /// 命令两阶段全部完成,落到的新 revision。
    Settled { revision: u64 },
    /// 命令已入在途并记入槽位。
    Staged { invocation: u64 },
    /// 输入事件已派发;`changed` 表明交互状态是否实际变化。
    Applied { changed: bool },
    /// 种子化随机数抽取结果。
    Drawn { values: Vec<u64> },
    /// sim 源已取消(重复取消同为该结果,幂等)。
    Cancelled,
    /// 被拒:提交/结算/派发任一阶段,状态不变。
    Rejected { reason: String },
    /// 取消后的 sim tick:尾部不再产出,游标与计数不动。
    NoOutput,
}

/// 单步结束后的全量状态摘要:目标状态轨迹 + 重放比较的载体。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StateDigest {
    pub now_ms: u64,
    pub sim_committed_ticks: u64,
    pub sim_cancelled: bool,
    /// 已取消时为 `None`(与「时钟耗尽」可由 `sim_cancelled` 区分)。
    pub sim_due_ms: Option<u64>,
    pub chart_data_revision: u64,
    pub chart_revision: u64,
    pub bus_revision: u64,
    pub bus_in_flight: usize,
    pub hidden_series: Vec<String>,
    pub highlighted: Option<(String, Option<usize>)>,
    pub selected: Vec<(String, Option<usize>)>,
    pub zoom_windows: Vec<(String, f64, f64)>,
    pub tooltip: Option<TooltipDigest>,
    pub emphasis_series: Vec<String>,
    pub emphasis_cells: Vec<(String, usize)>,
    /// main 数据集尾部一行与总行数:sim 滚动窗口的状态可从摘要直接比对。
    pub last_row: Option<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub target: TargetDigest,
    /// RNG 内部状态:随机消费步数或种子不一致时摘要必然分叉。
    pub rng_state: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TooltipDigest {
    pub series_id: String,
    pub data_index: usize,
    pub x_value: String,
    pub y_value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TargetDigest {
    pub scene: BTreeMap<String, SceneCell>,
    pub selection: Vec<String>,
    pub focused: Option<String>,
    pub data_requests: u64,
    pub cancelled_tasks: u64,
}

/// 一条轨迹记录 = 类别 + 结果 + 该步结束时的状态摘要 + display hash。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StepRecord {
    pub step: usize,
    pub kind: StepKind,
    pub outcome: StepOutcome,
    pub digest: StateDigest,
    pub display_hash: String,
}

/// 完整回放轨迹。`wire_bytes` 供双跑逐字节比较。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReplayTrace {
    pub steps: Vec<StepRecord>,
}

impl ReplayTrace {
    pub fn wire_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("trace serialization")
    }
}

/// 提交拒绝的人话描述:原因 + 关键数值,供轨迹审计与断言。
pub(super) fn describe_submit(rejection: &SubmitRejection) -> String {
    match rejection {
        SubmitRejection::StaleRevision { expected, current } => format!(
            "submit rejected: stale revision (expected {}, current {})",
            expected.0, current.0
        ),
        SubmitRejection::UnsupportedSchemaVersion { found } => {
            format!("submit rejected: unsupported schema version {found}")
        }
        SubmitRejection::InvalidNodeId { node_id } => {
            format!("submit rejected: invalid node id {node_id:?}")
        }
        SubmitRejection::InvalidInvocationId { reason } => {
            format!("submit rejected: invalid invocation id ({reason})")
        }
        SubmitRejection::DuplicateIdempotencyKey { key } => {
            format!("submit rejected: duplicate idempotency key {key:?}")
        }
        SubmitRejection::InvalidIdempotencyKey { reason } => {
            format!("submit rejected: invalid idempotency key ({reason})")
        }
        SubmitRejection::MissingCapability { capability } => {
            format!("submit rejected: missing capability {}", capability.0)
        }
        SubmitRejection::InFlightBudgetExceeded { in_flight, max } => {
            format!("submit rejected: in-flight budget exceeded ({in_flight}/{max})")
        }
        SubmitRejection::TimeoutBudgetExceeded {
            requested_ms,
            max_ms,
        } => format!(
            "submit rejected: timeout budget exceeded (requested {requested_ms} ms, max {max_ms} ms)"
        ),
        SubmitRejection::InvalidPayload { reason } => {
            format!("submit rejected: invalid payload ({reason})")
        }
        SubmitRejection::DuplicateInvocation { invocation } => {
            format!("submit rejected: duplicate invocation {}", invocation.0)
        }
    }
}

pub(super) fn describe_settle(rejection: &SettleRejection) -> String {
    match rejection {
        SettleRejection::RevisionMoved { expected, current } => format!(
            "settle rejected: revision moved while in flight (expected {}, current {})",
            expected.0, current.0
        ),
        SettleRejection::NotInFlight { invocation } => {
            format!("settle rejected: invocation {} not in flight", invocation.0)
        }
        SettleRejection::Cancelled { invocation } => {
            format!("settle rejected: invocation {} was cancelled", invocation.0)
        }
        SettleRejection::TimedOut {
            elapsed_ms,
            timeout_ms,
        } => format!("settle rejected: timed out after {elapsed_ms} ms (budget {timeout_ms} ms)"),
        SettleRejection::ApplyFailed { reason } => {
            format!("settle rejected: apply failed ({reason})")
        }
    }
}
