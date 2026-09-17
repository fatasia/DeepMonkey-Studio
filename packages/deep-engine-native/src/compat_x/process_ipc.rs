use super::*;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Envelope {
    pub(super) version: u32,
    pub(super) budget: XBudget,
    pub(super) request: XRequest,
    pub(super) context: XExecutionContext,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    result: Result<WireCandidate, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireCandidate {
    expected_epoch: u64,
    started_at_ms: u64,
    messages: Vec<XMessage>,
    request_hash: String,
    output_hash: String,
}

impl From<XCandidate> for WireCandidate {
    fn from(value: XCandidate) -> Self {
        Self {
            expected_epoch: value.expected_epoch,
            started_at_ms: value.started_at_ms,
            messages: value.messages,
            request_hash: value.request_hash,
            output_hash: value.output_hash,
        }
    }
}

pub(super) fn io_error(error: impl std::fmt::Display) -> XProcessError {
    XProcessError::Io(error.to_string())
}

pub(super) fn read_bounded(input: impl Read) -> Result<Vec<u8>, XProcessError> {
    let mut bytes = Vec::new();
    input
        .take((MAX_IPC_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_IPC_BYTES {
        return Err(XProcessError::IpcBudgetExceeded);
    }
    Ok(bytes)
}

struct LimitedBuffer(Vec<u8>);
impl Write for LimitedBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_IPC_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("X IPC budget exceeded"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) fn encode(value: &impl Serialize) -> Result<Vec<u8>, XProcessError> {
    let mut buffer = LimitedBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, value).map_err(|_| XProcessError::IpcBudgetExceeded)?;
    Ok(buffer.0)
}

/// Worker 的唯一入口：一次请求、一次回执；不接受源码或注入宿主对象。
pub fn serve(input: impl Read, mut output: impl Write) -> Result<(), XProcessError> {
    let bytes = read_bounded(input)?;
    let envelope: Envelope = serde_json::from_slice(&bytes).map_err(io_error)?;
    if envelope.version != X_COMPATIBILITY_SCHEMA_VERSION {
        return Err(XProcessError::InvalidReceipt);
    }
    let result = XCompatibilityHost::new(true, envelope.budget)
        .and_then(|host| {
            host.evaluate(
                CompatibilityLane::ExperimentalX,
                &envelope.request,
                envelope.context,
            )
        })
        .map(WireCandidate::from)
        .map_err(|error| format!("{error:?}"));
    let receipt = encode(&Receipt {
        version: X_COMPATIBILITY_SCHEMA_VERSION,
        result,
    })?;
    output.write_all(&receipt).map_err(io_error)?;
    output.flush().map_err(io_error)
}

pub(super) fn validate_receipt(
    bytes: &[u8],
    request: &XRequest,
    budget: XBudget,
) -> Result<XCandidate, XProcessError> {
    let receipt: Receipt =
        serde_json::from_slice(bytes).map_err(|_| XProcessError::InvalidReceipt)?;
    if receipt.version != X_COMPATIBILITY_SCHEMA_VERSION {
        return Err(XProcessError::InvalidReceipt);
    }
    let candidate = receipt.result.map_err(XProcessError::WorkerRejected)?;
    host::validate_messages(&candidate.messages).map_err(|_| XProcessError::InvalidReceipt)?;
    let request_hash =
        crate::shader_package::hash::hash_canonical(&host::request_hash_value(request));
    let messages = serde_json::Value::Array(
        candidate
            .messages
            .iter()
            .map(host::message_hash_value)
            .collect(),
    );
    let output_hash = crate::shader_package::hash::hash_canonical(&messages);
    if candidate.expected_epoch != request.expected_epoch
        || candidate.started_at_ms != request.started_at_ms
        || candidate.request_hash != request_hash
        || candidate.output_hash != output_hash
        || candidate.messages.len() > budget.max_messages
        || candidate
            .messages
            .iter()
            .map(host::message_bytes)
            .sum::<usize>()
            > budget.max_message_bytes
    {
        return Err(XProcessError::InvalidReceipt);
    }
    Ok(XCandidate {
        expected_epoch: candidate.expected_epoch,
        started_at_ms: candidate.started_at_ms,
        messages: candidate.messages,
        request_hash: candidate.request_hash,
        output_hash: candidate.output_hash,
    })
}
