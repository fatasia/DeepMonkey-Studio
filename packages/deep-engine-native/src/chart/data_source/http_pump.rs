//! P1-13 宿主泵:把 HTTP 请求-响应装配到 `DataSourceMachine` 的事件面。
//! 状态机的连接/退避/静默窗口/版本治理语义不被绕过——本模块只负责:
//! 按需 connect → machine.send(请求体) → 从 HttpTransport 取响应 →
//! 组装 `DataSourcePayload` → `on_receive_at` 泵入,并把判定结果交还宿主。
//! 本模块是 `data_source` 的子模块,因此可以访问机器的私有 transport 字段;
//! 对外只暴露 `poll_http_once` 与便捷构造,机器的不变量仍由状态机自己维护。

use super::DataSourceMachine;
use super::contract::*;
use super::http_transport::{HttpTransport, HttpTransportConfig};

#[derive(Debug)]
pub struct HttpPollOutcome {
    /// `on_receive_at` 的判定;连接或发送失败时为 None(状态机已自行调度退避)。
    pub verdict: Option<ReceiveVerdict>,
    /// 响应字节数;连接或发送失败时为 0。
    pub bytes: usize,
}

/// 单次轮询:确保连接(Disconnected/退避到期自动重连)、发送请求体、
/// 取走响应并按 `source_version` 泵入状态机。调用方以固定节拍驱动即可。
pub fn poll_http_once(
    machine: &mut DataSourceMachine<HttpTransport>,
    source_version: u64,
    body: &[u8],
    now_ms: u64,
) -> Result<HttpPollOutcome, String> {
    match machine.state() {
        DataSourceState::Closed => return Err("data source closed".into()),
        DataSourceState::Connected => {}
        DataSourceState::Connecting => return Err("data source connect still in flight".into()),
        DataSourceState::Disconnected | DataSourceState::Retrying { .. } => {
            machine.connect(now_ms)?;
            // connect 失败已在状态机内调度退避;本次轮询没有可发送的东西。
            if !matches!(machine.state(), DataSourceState::Connected) {
                return Ok(HttpPollOutcome {
                    verdict: None,
                    bytes: 0,
                });
            }
        }
    }
    // Connection: close 下每次 send 后连接即关闭,下一次轮询必然重连;
    // send 失败(含"not connected")已在状态机内 close+调度退避,按节拍语义返回空轮。
    if machine.send(body, now_ms).is_err() {
        return Ok(HttpPollOutcome {
            verdict: None,
            bytes: 0,
        });
    }
    let Some(bytes) = machine.transport.take_response() else {
        // send 成功但实现未留响应:协议违规,走 error 通道调度退避。
        machine.on_error("http response missing after send", now_ms)?;
        return Ok(HttpPollOutcome {
            verdict: None,
            bytes: 0,
        });
    };
    let payload = DataSourcePayload {
        source_id: machine.source_id().to_string(),
        source_version,
        bytes: bytes.clone(),
    };
    let verdict = machine.on_receive_at(payload, now_ms);
    Ok(HttpPollOutcome {
        verdict: Some(verdict),
        bytes: bytes.len(),
    })
}

/// 便捷构造:同一份 HTTP 配置同时驱动状态机 transport 与响应泵,
/// 避免"泵拿的 transport"与"机器里的 transport"成为两个实例。
pub fn new_http_machine(
    config: DataSourceConfig,
    http: HttpTransportConfig,
) -> Result<DataSourceMachine<HttpTransport>, String> {
    DataSourceMachine::new(config, HttpTransport::new(http)?)
}
