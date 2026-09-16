use super::*;
use crate::behavior_ir::validation::validate_payload;

impl<T: BehaviorTarget> CommandBus<T> {
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
        if self.in_flight.contains_key(&command.invocation_id)
            || self.terminal_invocations.contains(&command.invocation_id)
        {
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
        self.idempotency_order
            .push_back(command.idempotency_key.clone());
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
}
