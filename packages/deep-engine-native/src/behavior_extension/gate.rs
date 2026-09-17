//! 命令门控:经注册的扩展才能把命令送入 [`CommandBus`],撤销后全部拒绝。
//!
//! 职责边界(不建第二套状态机):幂等键、CAS、在途账目、终态记忆仍是总线的
//! 独占状态;门控只判定**扩展身份轴**——在册、未撤销、能力在授权集内、
//! 命令花费不超生效份额——然后把命令原样移交总线,总线拒绝原样透传。

use super::contract::*;
use super::registry::ExtensionHost;
use crate::behavior_ir::{BehaviorCommand, BehaviorTarget, InvocationId};
use std::collections::BTreeSet;

impl<T: BehaviorTarget> ExtensionHost<T> {
    /// 以扩展身份提交命令。通过门控后与 `CommandBus::submit` 同义:
    /// 成功进入在途,返回 invocation;此后结算/取消仍走总线的既有 API,
    /// 宿主须对终态 invocation 调用 [`ExtensionHost::release`] 归还跟踪名额。
    ///
    /// 门控顺序:身份 → 能力授权 → 超时份额 → 在途跟踪容量 → 总线。
    /// 身份判定最廉价且决定一切;能力与份额是扩展自身的授权面;
    /// 全局合同(幂等/CAS/全局预算/载荷)最后由总线统一裁决。
    pub fn submit(
        &mut self,
        extension_id: &str,
        command: BehaviorCommand,
        now_ms: u64,
    ) -> Result<InvocationId, ExtensionSubmitRejection> {
        // 先把授权面复制出来,避免可变借用计数器与只读借用记录打架;
        // 授权集与预算都是小结构,克隆成本可忽略。
        let (granted, allowed_timeout_ms, max_tracked) = match self.records.get(extension_id) {
            Some(record) => (
                record.granted.clone(),
                record.effective_budget.max_command_timeout_ms,
                record.effective_budget.max_in_flight,
            ),
            None => {
                self.counters.submit_rejected_extension += 1;
                return Err(if self.revoked_ids.contains(extension_id) {
                    ExtensionSubmitRejection::Revoked {
                        extension_id: extension_id.to_owned(),
                    }
                } else {
                    ExtensionSubmitRejection::NotRegistered {
                        extension_id: extension_id.to_owned(),
                    }
                });
            }
        };
        if let Some(capability) = command.required_capacity
            && !granted.contains(&capability)
        {
            self.counters.submit_rejected_extension += 1;
            return Err(ExtensionSubmitRejection::CapabilityNotGranted { capability });
        }
        if command.timeout_ms > allowed_timeout_ms {
            self.counters.submit_rejected_extension += 1;
            return Err(ExtensionSubmitRejection::ExtensionTimeoutExceeded {
                requested_ms: command.timeout_ms,
                allowed_ms: allowed_timeout_ms,
            });
        }
        if self.tracked_len(extension_id) >= max_tracked {
            self.counters.submit_rejected_extension += 1;
            return Err(ExtensionSubmitRejection::ExtensionInFlightExhausted {
                extension_id: extension_id.to_owned(),
                max: max_tracked,
            });
        }
        match self.bus.submit(command, now_ms) {
            Ok(returned) => {
                self.tracked
                    .entry(extension_id.to_owned())
                    .or_default()
                    .insert(returned);
                self.counters.submit_accepted += 1;
                Ok(returned)
            }
            Err(rejection) => {
                self.counters.submit_rejected_bus += 1;
                Err(ExtensionSubmitRejection::BusRejected(rejection))
            }
        }
    }

    /// 命令在总线上进入终态(settle/取消/超时)后,宿主据此归还跟踪名额。
    /// 返回该引用是否确由本扩展跟踪;对未知引用是 `false` 而非错误。
    pub fn release(&mut self, extension_id: &str, invocation: InvocationId) -> bool {
        self.tracked
            .get_mut(extension_id)
            .is_some_and(|set| set.remove(&invocation))
    }

    /// 供测试与宿主诊断:某扩展当前被跟踪的引用数。
    pub fn tracked_len(&self, extension_id: &str) -> usize {
        self.tracked
            .get(extension_id)
            .map(BTreeSet::len)
            .unwrap_or(0)
    }
}
