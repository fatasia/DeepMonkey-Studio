use serde::Serialize;

pub const X_COMPATIBILITY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompatibilityLane {
    NativeN0,
    ExperimentalX,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XBudget {
    pub max_cpu_units: u64,
    pub max_memory_bytes: usize,
    pub max_call_depth: usize,
    pub max_messages: usize,
    pub max_message_bytes: usize,
    pub max_wall_clock_ms: u64,
}

impl Default for XBudget {
    fn default() -> Self {
        Self {
            max_cpu_units: 65_536,
            max_memory_bytes: 8 * 1024 * 1024,
            max_call_depth: 16,
            max_messages: 1_024,
            max_message_bytes: 1024 * 1024,
            max_wall_clock_ms: 1_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XResource {
    pub id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "kebab-case")]
pub enum XEvent {
    Pointer { x: f64, y: f64 },
    Key { code: XKey },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum XKey {
    Enter,
    Escape,
    ArrowLeft,
    ArrowRight,
}

/// 封闭适配调用，不含源码、表达式、回调或自定义 JSON。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "op", content = "args", rename_all = "kebab-case")]
pub enum XCall {
    Sequence(Vec<XCall>),
    ReadClock,
    DrawRandom,
    ReadResourceByte { resource_id: String, offset: usize },
    ReadEvent { index: usize },
    EmitNumber(f64),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "kebab-case")]
pub enum XMessage {
    Clock(u64),
    Random(u64),
    ResourceByte {
        resource_id: String,
        offset: usize,
        value: u8,
    },
    Event(XEvent),
    Number(f64),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XRequest {
    pub schema_version: u32,
    pub expected_epoch: u64,
    pub started_at_ms: u64,
    pub random_seed: u64,
    pub resources: Vec<XResource>,
    pub events: Vec<XEvent>,
    pub calls: Vec<XCall>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XExecutionContext {
    pub current_epoch: u64,
    pub now_ms: u64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XRejection {
    InvalidBudget,
    UnsupportedSchemaVersion { received: u32 },
    Disabled,
    NativeN0Isolated,
    Cancelled,
    StaleEpoch { expected: u64, current: u64 },
    ClockRegressed,
    WallClockBudgetExceeded,
    CpuBudgetExceeded,
    MemoryBudgetExceeded,
    CallDepthExceeded,
    MessageBudgetExceeded,
    InvalidInput(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct XCandidate {
    pub(super) expected_epoch: u64,
    pub(super) started_at_ms: u64,
    pub(super) messages: Vec<XMessage>,
    pub(super) request_hash: String,
    pub(super) output_hash: String,
}

impl XCandidate {
    pub fn messages(&self) -> &[XMessage] {
        &self.messages
    }

    pub fn request_hash(&self) -> &str {
        &self.request_hash
    }

    pub fn output_hash(&self) -> &str {
        &self.output_hash
    }
}
