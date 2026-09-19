//! Runtime Package 增量差异计划:对比旧/新 resource index,输出确定性的
//! 增量更新计划,供增量加载器复用已解码 payload。
//!
//! reuse 不产生待执行条目,由 `reused` 计数表达(与 prewarm 执行器的
//! reused 统计口径一致),因此两侧索引完全相同即得空计划。
//!
//! 失败关闭:同一输入内出现重复 (id, kind) 说明索引损坏;id+kind+revision
//! 相同但 content_hash 不同说明索引自相矛盾(sha256 已在加载时校验过内容),
//! 两者都不猜测,直接返回 Err。

use std::cmp::Ordering;

use serde::Serialize;

use super::{
    LoadedRuntimePackage, RuntimeContentHash, RuntimePackageError, RuntimeResourceIndexEntry,
    RuntimeResourceKind, fail,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeResourcePlanAction {
    Add,
    Replace,
    Remove,
}

/// 条目的 `revision` 与 `content_hash` 描述目标侧状态(remove 时为被移除资源
/// 的旧值),计划因此可直接驱动执行,无需再回查旧索引。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourcePlanEntry {
    pub action: RuntimeResourcePlanAction,
    pub id: String,
    pub kind: RuntimeResourceKind,
    pub revision: u64,
    pub content_hash: RuntimeContentHash,
}

// `RuntimeContentHash` 未派生 PartialEq 且 types.rs 不在本次改动范围,
// 这里对哈希逐字段比较,语义与结构体等价。
impl PartialEq for RuntimeResourcePlanEntry {
    fn eq(&self, other: &Self) -> bool {
        self.action == other.action
            && self.id == other.id
            && self.kind == other.kind
            && self.revision == other.revision
            && (
                self.content_hash.algorithm.as_str(),
                self.content_hash.value.as_str(),
            ) == (
                other.content_hash.algorithm.as_str(),
                other.content_hash.value.as_str(),
            )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceDiffPlan {
    /// 待执行动作,按 (id, kind) 排序;同 id 时按 `RuntimeResourceKind` 声明序。
    pub entries: Vec<RuntimeResourcePlanEntry>,
    /// 两侧 id+kind+revision+hash 完全一致、可原样保留的资源数。
    pub reused: usize,
}

impl RuntimeResourceDiffPlan {
    /// 空计划 = 无任何待执行动作;调用方可据此整体跳过增量更新。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

pub fn plan_runtime_package_diff(
    old: &LoadedRuntimePackage,
    new: &LoadedRuntimePackage,
) -> Result<RuntimeResourceDiffPlan, RuntimePackageError> {
    plan_runtime_package_resource_diff(&old.resource_index, &new.resource_index)
}

pub fn plan_runtime_package_resource_diff(
    old: &[RuntimeResourceIndexEntry],
    new: &[RuntimeResourceIndexEntry],
) -> Result<RuntimeResourceDiffPlan, RuntimePackageError> {
    let old = sorted_unique(old)?;
    let new = sorted_unique(new)?;
    let mut entries = Vec::new();
    let mut reused = 0;
    let (mut old_pos, mut new_pos) = (0, 0);
    while old_pos < old.len() || new_pos < new.len() {
        let ordering = match (old.get(old_pos), new.get(new_pos)) {
            (Some(old_entry), Some(new_entry)) => key(old_entry).cmp(&key(new_entry)),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => unreachable!("loop condition keeps one side non-empty"),
        };
        match ordering {
            Ordering::Less => {
                entries.push(plan_entry(RuntimeResourcePlanAction::Remove, old[old_pos]));
                old_pos += 1;
            }
            Ordering::Greater => {
                entries.push(plan_entry(RuntimeResourcePlanAction::Add, new[new_pos]));
                new_pos += 1;
            }
            Ordering::Equal => {
                let (old_entry, new_entry) = (&old[old_pos], &new[new_pos]);
                if old_entry.revision != new_entry.revision {
                    entries.push(plan_entry(RuntimeResourcePlanAction::Replace, new_entry));
                } else if same_content_hash(&old_entry.content_hash, &new_entry.content_hash) {
                    reused += 1;
                } else {
                    return fail(format!(
                        "runtime resource {:?} keeps revision {} but its content hash changed; \
                         incremental diff requires a revision bump",
                        old_entry.id, old_entry.revision
                    ));
                }
                old_pos += 1;
                new_pos += 1;
            }
        }
    }
    Ok(RuntimeResourceDiffPlan { entries, reused })
}

fn plan_entry(
    action: RuntimeResourcePlanAction,
    entry: &RuntimeResourceIndexEntry,
) -> RuntimeResourcePlanEntry {
    RuntimeResourcePlanEntry {
        action,
        id: entry.id.clone(),
        kind: entry.kind,
        revision: entry.revision,
        content_hash: entry.content_hash.clone(),
    }
}

/// `RuntimeResourceKind` 未派生 Ord;按类型声明序给出稳定次序。
fn kind_order(kind: RuntimeResourceKind) -> u8 {
    match kind {
        RuntimeResourceKind::RenderPacket => 0,
        RuntimeResourceKind::Deep2dRuntime => 1,
        RuntimeResourceKind::IblEnvironment => 2,
        RuntimeResourceKind::ShaderPackage => 3,
        RuntimeResourceKind::SceneCamera => 4,
        RuntimeResourceKind::ChartRuntime => 5,
        RuntimeResourceKind::ChartSimRuntime => 6,
        RuntimeResourceKind::DashboardRuntime => 7,
        RuntimeResourceKind::ExperimentalX => 8,
        RuntimeResourceKind::DynamicRuntime => 9,
    }
}

fn key(entry: &RuntimeResourceIndexEntry) -> (&str, u8) {
    (entry.id.as_str(), kind_order(entry.kind))
}

fn same_content_hash(left: &RuntimeContentHash, right: &RuntimeContentHash) -> bool {
    left.algorithm == right.algorithm && left.value == right.value
}

/// 排序后的只读视图;先排序再归并,使输出与调用方传入顺序无关。
fn sorted_unique(
    entries: &[RuntimeResourceIndexEntry],
) -> Result<Vec<&RuntimeResourceIndexEntry>, RuntimePackageError> {
    let mut sorted: Vec<&RuntimeResourceIndexEntry> = entries.iter().collect();
    sorted.sort_by(|left, right| key(left).cmp(&key(right)));
    if let Some(pair) = sorted.windows(2).find(|pair| key(pair[0]) == key(pair[1])) {
        return fail(format!(
            "duplicate runtime resource id {:?} with kind {:?}",
            pair[0].id, pair[0].kind
        ));
    }
    Ok(sorted)
}
