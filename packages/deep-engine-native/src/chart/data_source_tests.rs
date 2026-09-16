//! P1-13 第一批:数据源状态机,全部固定时钟与脚本 Transport,无真实等待。
use super::{
    DataSourceConfig, DataSourceMachine, DataSourcePayload, DataSourceState, ReceiveVerdict,
    Transport, TransportFailure, TransportOutcome, payload_to_chart_message,
};
use crate::chart::{ChartRuntime, parse_chart_ir};
use serde_json::json;
use std::collections::VecDeque;

const SOURCE_ID: &str = "telemetry-main";
const T0: u64 = 1_000;

/// 固定脚本 Mock:connect/send 逐次弹出脚本结果,脚本耗尽即测试缺陷,直接 panic。
/// close 只增计数不清空状态,便于断言「关闭且仅关闭一次」。
struct ScriptedTransport {
    connect_script: VecDeque<TransportOutcome>,
    send_script: VecDeque<TransportOutcome>,
    sent: Vec<Vec<u8>>,
    close_count: usize,
}

impl ScriptedTransport {
    fn new(connect: Vec<TransportOutcome>) -> Self {
        Self {
            connect_script: connect.into(),
            send_script: VecDeque::new(),
            sent: Vec::new(),
            close_count: 0,
        }
    }
    fn with_sends(connect: Vec<TransportOutcome>, send: Vec<TransportOutcome>) -> Self {
        Self {
            connect_script: connect.into(),
            send_script: send.into(),
            sent: Vec::new(),
            close_count: 0,
        }
    }
    fn pop(script: &mut VecDeque<TransportOutcome>) -> TransportOutcome {
        script.pop_front().expect("transport script exhausted")
    }
}

impl Transport for ScriptedTransport {
    fn connect(&mut self) -> TransportOutcome {
        Self::pop(&mut self.connect_script)
    }
    fn send(&mut self, bytes: &[u8]) -> TransportOutcome {
        self.sent.push(bytes.to_vec());
        Self::pop(&mut self.send_script)
    }
    fn close(&mut self) {
        self.close_count += 1;
    }
}

fn config(capacity: usize) -> DataSourceConfig {
    DataSourceConfig {
        source_id: SOURCE_ID.into(),
        cache_capacity: capacity,
        // 0 = 不设字节预算/不设 deadline,保持既有用例的行为面不变。
        cache_byte_budget: 0,
        idle_deadline_ms: 0,
        backoff_base_ms: 4,
        backoff_max_ms: 64,
    }
}

fn payload(source_id: &str, version: u64) -> DataSourcePayload {
    DataSourcePayload {
        source_id: source_id.into(),
        source_version: version,
        bytes: update_bytes(0),
    }
}

/// 合法 chart-data-update 负载;`base_revision` 故意写死,证明适配时会被 CAS 重写。
fn update_bytes(base_revision: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "schema": "deep-engine.chart-data-update", "schemaVersion": 1,
        "chartId": "chart-v1-golden",
        "expectedDataRevision": base_revision, "dataRevision": base_revision + 1,
        "datasets": [{ "kind": "append-window", "datasetId": "main",
            "rows": [["D", 4, 0.4, "水箱四"]], "maxRows": 3 }]
    }))
    .unwrap()
}

fn delivered(
    machine: &mut DataSourceMachine<ScriptedTransport>,
    source_id: &str,
    version: u64,
) -> DataSourcePayload {
    match machine.on_receive(payload(source_id, version)) {
        ReceiveVerdict::Delivered(payload) => payload,
        verdict => panic!("expected delivery of v{version}, got {verdict:?}"),
    }
}

#[path = "data_source/contract_tests.rs"]
mod contract;

#[path = "data_source/connection_tests.rs"]
mod connection;

#[path = "data_source/receive_tests.rs"]
mod receive;

#[path = "data_source/idle_tests.rs"]
mod idle;
