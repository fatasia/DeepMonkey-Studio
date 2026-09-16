//! 宿主数据源状态机(P1-13 第一批,离线优先):注入式 Transport + 完整状态机 +
//! 有界离线缓存 + sourceVersion 版本治理 + source 身份隔离。
//! 全部时间由调用方以 `now_ms` 注入,无墙钟、无线程、无真实 IO;真实 HTTP/订阅
//! 绑定(异步握手、TLS、重定向)是后续切片,经 `Transport` 接入,状态机不变。
//!
//! 凭据边界:连接凭据**不出现在本模块**。凭据由 host 配置持有,并在构造
//! `Transport` 实现时注入该实现内部(不落盘的 opaque 边界);状态机只消费连接结果。
use std::collections::VecDeque;

mod chart_adapter;
mod connection;
mod contract;
mod idle;
mod receive;

pub use chart_adapter::payload_to_chart_message;
pub use contract::*;

pub struct DataSourceMachine<T: Transport> {
    config: DataSourceConfig,
    transport: T,
    state: DataSourceState,
    /// 最新已接受的 sourceVersion;None 表示尚未接受任何版本(版本序列允许从 0 起)。
    committed_version: Option<u64>,
    cache: VecDeque<DataSourcePayload>,
    /// 缓存当前字节数(与 cache 同步维护,避免每次淘汰重算整表)。
    cache_bytes: usize,
    counters: DataSourceCounters,
    /// 最近一次进入 Retrying 的失败原因,供宿主诊断;成功连接后不清除。
    last_failure: Option<String>,
    /// 连接建立后最近一次活动(收发)的时刻;非 Connected 时为 None。
    /// 与 `idle_deadline_ms` 共同构成静默检测。
    last_activity_ms: Option<u64>,
}

impl<T: Transport> DataSourceMachine<T> {
    pub fn new(config: DataSourceConfig, transport: T) -> Result<Self, String> {
        Ok(Self {
            config: config.validated()?,
            transport,
            state: DataSourceState::Disconnected,
            committed_version: None,
            cache: VecDeque::new(),
            cache_bytes: 0,
            counters: DataSourceCounters::default(),
            last_failure: None,
            last_activity_ms: None,
        })
    }

    pub fn state(&self) -> &DataSourceState {
        &self.state
    }
    pub fn committed_source_version(&self) -> Option<u64> {
        self.committed_version
    }
    pub fn counters(&self) -> &DataSourceCounters {
        &self.counters
    }
    pub fn cache_len(&self) -> usize {
        self.cache.len()
    }
    /// 缓存当前占用字节数(负载 bytes + source 身份)。
    pub fn cache_bytes(&self) -> usize {
        self.cache_bytes
    }
    pub fn last_failure(&self) -> Option<&str> {
        self.last_failure.as_deref()
    }
    /// 连接建立后最近一次活动时刻;`None` 表示当前不在连接态。
    pub fn last_activity(&self) -> Option<u64> {
        self.last_activity_ms
    }
}

#[cfg(test)]
#[path = "data_source_tests.rs"]
mod tests;
