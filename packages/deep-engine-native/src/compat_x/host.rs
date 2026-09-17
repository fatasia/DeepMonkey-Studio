use super::contract::*;
use crate::{behavior_ir::stable_node_id, replay::ReplayRng};
use serde_json::{Value, json};

const MAX_CALL_DEPTH_LIMIT: usize = 64;
const MAX_CPU_UNITS_LIMIT: u64 = 1_000_000;
const MAX_MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const MAX_MESSAGES_LIMIT: usize = 4_096;
const MAX_WALL_CLOCK_LIMIT_MS: u64 = 60_000;

pub struct XCompatibilityHost {
    enabled: bool,
    budget: XBudget,
}

impl XCompatibilityHost {
    pub fn new(enabled: bool, budget: XBudget) -> Result<Self, XRejection> {
        if budget.max_cpu_units == 0
            || budget.max_cpu_units > MAX_CPU_UNITS_LIMIT
            || budget.max_memory_bytes == 0
            || budget.max_memory_bytes > MAX_MEMORY_LIMIT
            || budget.max_call_depth == 0
            || budget.max_call_depth > MAX_CALL_DEPTH_LIMIT
            || budget.max_messages == 0
            || budget.max_messages > MAX_MESSAGES_LIMIT
            || budget.max_message_bytes == 0
            || budget.max_message_bytes > budget.max_memory_bytes
            || budget.max_wall_clock_ms == 0
            || budget.max_wall_clock_ms > MAX_WALL_CLOCK_LIMIT_MS
        {
            return Err(XRejection::InvalidBudget);
        }
        Ok(Self { enabled, budget })
    }

    pub fn evaluate(
        &self,
        lane: CompatibilityLane,
        request: &XRequest,
        context: XExecutionContext,
    ) -> Result<XCandidate, XRejection> {
        self.guard(lane, request.expected_epoch, request.started_at_ms, context)?;
        let mut state = EvaluationState::new(request, context.now_ms, self.budget)?;
        for call in &request.calls {
            state.evaluate(call, 1)?;
        }
        let request_value = request_hash_value(request);
        let output_value = Value::Array(state.messages.iter().map(message_hash_value).collect());
        Ok(XCandidate {
            expected_epoch: request.expected_epoch,
            started_at_ms: request.started_at_ms,
            messages: state.messages,
            request_hash: crate::shader_package::hash::hash_canonical(&request_value),
            output_hash: crate::shader_package::hash::hash_canonical(&output_value),
        })
    }

    /// 发布前重查旧 epoch、迟到和取消；消费候选保证拒绝后调用方不能误用部分输出。
    pub fn publish(
        &self,
        lane: CompatibilityLane,
        candidate: XCandidate,
        context: XExecutionContext,
    ) -> Result<Vec<XMessage>, XRejection> {
        self.guard(
            lane,
            candidate.expected_epoch,
            candidate.started_at_ms,
            context,
        )?;
        Ok(candidate.messages)
    }

    pub(super) fn guard(
        &self,
        lane: CompatibilityLane,
        expected_epoch: u64,
        started_at_ms: u64,
        context: XExecutionContext,
    ) -> Result<(), XRejection> {
        if lane == CompatibilityLane::NativeN0 {
            return Err(XRejection::NativeN0Isolated);
        }
        if !self.enabled {
            return Err(XRejection::Disabled);
        }
        if context.cancelled {
            return Err(XRejection::Cancelled);
        }
        if expected_epoch != context.current_epoch {
            return Err(XRejection::StaleEpoch {
                expected: expected_epoch,
                current: context.current_epoch,
            });
        }
        let elapsed = context
            .now_ms
            .checked_sub(started_at_ms)
            .ok_or(XRejection::ClockRegressed)?;
        if elapsed > self.budget.max_wall_clock_ms {
            return Err(XRejection::WallClockBudgetExceeded);
        }
        Ok(())
    }
}

// Floats are part of the contract as IEEE-754 bit strings. This avoids runtime-
// specific decimal formatting and preserves signed zero without admitting NaN.
fn float_bits(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}

fn event_hash_value(event: &XEvent) -> Value {
    match event {
        XEvent::Pointer { x, y } => json!({
            "type": "pointer",
            "xBits": float_bits(*x),
            "yBits": float_bits(*y),
        }),
        XEvent::Key { code } => json!({
            "type": "key",
            "code": match code {
                XKey::Enter => "enter",
                XKey::Escape => "escape",
                XKey::ArrowLeft => "arrow-left",
                XKey::ArrowRight => "arrow-right",
            },
        }),
    }
}

fn call_hash_value(call: &XCall) -> Value {
    match call {
        XCall::Sequence(calls) => json!({
            "op": "sequence",
            "calls": calls.iter().map(call_hash_value).collect::<Vec<_>>(),
        }),
        XCall::ReadClock => json!({ "op": "read-clock" }),
        XCall::DrawRandom => json!({ "op": "draw-random" }),
        XCall::ReadResourceByte {
            resource_id,
            offset,
        } => json!({
            "op": "read-resource-byte",
            "resourceId": resource_id,
            "offset": offset,
        }),
        XCall::ReadEvent { index } => json!({ "op": "read-event", "index": index }),
        XCall::EmitNumber(value) => {
            json!({ "op": "emit-number", "valueBits": float_bits(*value) })
        }
    }
}

pub(super) fn request_hash_value(request: &XRequest) -> Value {
    json!({
        "schemaVersion": request.schema_version,
        "expectedEpoch": request.expected_epoch,
        "startedAtMs": request.started_at_ms,
        "randomSeed": request.random_seed,
        "resources": request.resources.iter().map(|resource| json!({
            "id": resource.id,
            "bytes": resource.bytes,
        })).collect::<Vec<_>>(),
        "events": request.events.iter().map(event_hash_value).collect::<Vec<_>>(),
        "calls": request.calls.iter().map(call_hash_value).collect::<Vec<_>>(),
    })
}

pub(super) fn message_hash_value(message: &XMessage) -> Value {
    match message {
        XMessage::Clock(value) => json!({ "type": "clock", "value": value }),
        XMessage::Random(value) => json!({ "type": "random", "value": value }),
        XMessage::ResourceByte {
            resource_id,
            offset,
            value,
        } => json!({
            "type": "resource-byte",
            "resourceId": resource_id,
            "offset": offset,
            "value": value,
        }),
        XMessage::Event(event) => json!({ "type": "event", "event": event_hash_value(event) }),
        XMessage::Number(value) => {
            json!({ "type": "number", "valueBits": float_bits(*value) })
        }
    }
}

struct EvaluationState<'a> {
    request: &'a XRequest,
    now_ms: u64,
    budget: XBudget,
    rng: ReplayRng,
    cpu_units: u64,
    resident_bytes: usize,
    message_bytes: usize,
    messages: Vec<XMessage>,
}

impl<'a> EvaluationState<'a> {
    fn new(request: &'a XRequest, now_ms: u64, budget: XBudget) -> Result<Self, XRejection> {
        if request.schema_version != X_COMPATIBILITY_SCHEMA_VERSION {
            return Err(XRejection::UnsupportedSchemaVersion {
                received: request.schema_version,
            });
        }
        let mut resident_bytes = 0usize;
        let mut ids = std::collections::BTreeSet::new();
        for resource in &request.resources {
            if !stable_node_id(&resource.id) || !ids.insert(resource.id.as_str()) {
                return Err(XRejection::InvalidInput(
                    "resource identity must be stable and unique",
                ));
            }
            resident_bytes = resident_bytes
                .checked_add(resource.id.len())
                .and_then(|v| v.checked_add(resource.bytes.len()))
                .ok_or(XRejection::MemoryBudgetExceeded)?;
        }
        resident_bytes = resident_bytes
            .checked_add(request.events.len().saturating_mul(24))
            .ok_or(XRejection::MemoryBudgetExceeded)?;
        if request.events.iter().any(
            |event| matches!(event, XEvent::Pointer { x, y } if !x.is_finite() || !y.is_finite()),
        ) {
            return Err(XRejection::InvalidInput(
                "pointer coordinates must be finite",
            ));
        }
        if resident_bytes > budget.max_memory_bytes {
            return Err(XRejection::MemoryBudgetExceeded);
        }
        Ok(Self {
            request,
            now_ms,
            budget,
            rng: ReplayRng::new(request.random_seed),
            cpu_units: 0,
            resident_bytes,
            message_bytes: 0,
            messages: Vec::new(),
        })
    }

    fn evaluate(&mut self, call: &XCall, depth: usize) -> Result<(), XRejection> {
        if depth > self.budget.max_call_depth {
            return Err(XRejection::CallDepthExceeded);
        }
        self.resident_bytes = self
            .resident_bytes
            .checked_add(call_bytes(call))
            .ok_or(XRejection::MemoryBudgetExceeded)?;
        if self
            .resident_bytes
            .checked_add(self.message_bytes)
            .is_none_or(|value| value > self.budget.max_memory_bytes)
        {
            return Err(XRejection::MemoryBudgetExceeded);
        }
        self.cpu_units = self
            .cpu_units
            .checked_add(1)
            .ok_or(XRejection::CpuBudgetExceeded)?;
        if self.cpu_units > self.budget.max_cpu_units {
            return Err(XRejection::CpuBudgetExceeded);
        }
        match call {
            XCall::Sequence(calls) => {
                for call in calls {
                    self.evaluate(call, depth + 1)?;
                }
            }
            XCall::ReadClock => self.emit(XMessage::Clock(self.now_ms))?,
            XCall::DrawRandom => {
                let value = self.rng.next_u64();
                self.emit(XMessage::Random(value))?;
            }
            XCall::ReadResourceByte {
                resource_id,
                offset,
            } => {
                let resource = self
                    .request
                    .resources
                    .iter()
                    .find(|item| item.id == *resource_id)
                    .ok_or(XRejection::InvalidInput("resource was not injected"))?;
                let value = *resource
                    .bytes
                    .get(*offset)
                    .ok_or(XRejection::InvalidInput("resource offset is out of range"))?;
                self.emit(XMessage::ResourceByte {
                    resource_id: resource_id.clone(),
                    offset: *offset,
                    value,
                })?;
            }
            XCall::ReadEvent { index } => {
                let event = self
                    .request
                    .events
                    .get(*index)
                    .ok_or(XRejection::InvalidInput("event index is out of range"))?;
                if let XEvent::Pointer { x, y } = event
                    && (!x.is_finite() || !y.is_finite())
                {
                    return Err(XRejection::InvalidInput(
                        "pointer coordinates must be finite",
                    ));
                }
                self.emit(XMessage::Event(event.clone()))?;
            }
            XCall::EmitNumber(value) => {
                if !value.is_finite() {
                    return Err(XRejection::InvalidInput("emitted number must be finite"));
                }
                self.emit(XMessage::Number(*value))?;
            }
        }
        Ok(())
    }

    fn emit(&mut self, message: XMessage) -> Result<(), XRejection> {
        let bytes = message_bytes(&message);
        if self.messages.len() >= self.budget.max_messages
            || self
                .message_bytes
                .checked_add(bytes)
                .is_none_or(|value| value > self.budget.max_message_bytes)
        {
            return Err(XRejection::MessageBudgetExceeded);
        }
        let total = self
            .resident_bytes
            .checked_add(self.message_bytes)
            .and_then(|v| v.checked_add(bytes))
            .ok_or(XRejection::MemoryBudgetExceeded)?;
        if total > self.budget.max_memory_bytes {
            return Err(XRejection::MemoryBudgetExceeded);
        }
        self.message_bytes += bytes;
        self.messages.push(message);
        Ok(())
    }
}

pub(super) fn message_bytes(message: &XMessage) -> usize {
    match message {
        XMessage::Clock(_) | XMessage::Random(_) | XMessage::Number(_) => 8,
        XMessage::ResourceByte { resource_id, .. } => 17 + resource_id.len(),
        XMessage::Event(XEvent::Pointer { .. }) => 17,
        XMessage::Event(XEvent::Key { .. }) => 2,
    }
}

fn call_bytes(call: &XCall) -> usize {
    32 + match call {
        XCall::ReadResourceByte { resource_id, .. } => resource_id.len(),
        XCall::Sequence(_)
        | XCall::ReadClock
        | XCall::DrawRandom
        | XCall::ReadEvent { .. }
        | XCall::EmitNumber(_) => 0,
    }
}
