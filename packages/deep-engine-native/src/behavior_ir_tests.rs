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
    CommandBus::new(
        CommandBudget::default(),
        capabilities(),
        Recorder::default(),
    )
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
/// 先生成命令再调用 submit,避免同时可变借用总线。
fn command(bus: &mut CommandBus<Recorder>, key: &str, payload: BehaviorPayload) -> BehaviorCommand {
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

#[path = "behavior_ir/validation_tests.rs"]
mod validation;

#[path = "behavior_ir/lifecycle_tests.rs"]
mod lifecycle;

#[path = "behavior_ir/memory_tests.rs"]
mod memory;

#[path = "behavior_ir/terminal_tests.rs"]
mod terminal;
