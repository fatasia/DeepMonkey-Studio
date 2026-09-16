//! 宿主数据源状态机(P1-13 第一批,离线优先):注入式 Transport + 完整状态机 +
//! 有界离线缓存 + sourceVersion 版本治理 + source 身份隔离。
//! 全部时间由调用方以 `now_ms` 注入,无墙钟、无线程、无真实 IO;真实 HTTP/订阅
//! 绑定(异步握手、TLS、重定向)是后续切片,经 `Transport` 接入,状态机不变。
//!
//! 凭据边界:连接凭据**不出现在本模块**。凭据由 host 配置持有,并在构造
//! `Transport` 实现时注入该实现内部(不落盘的 opaque 边界);状态机只消费连接结果。
use super::interaction_contract::stable_id;
use super::{CHART_DATA_MESSAGE_MAX_BYTES, ChartDataMessage, parse_chart_data_update};
use std::collections::VecDeque;

/// 单个数据负载的最小合同:source 身份 + 源端版本 + 不透明字节负载。
/// `bytes` 的业务语义由宿主经 `payload_to_chart_message` 透传解析,本模块不解读。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataSourcePayload {
    pub source_id: String,
    pub source_version: u64,
    pub bytes: Vec<u8>,
}

/// 连接配置。凭据字段刻意不存在(见模块注释);退避参数有界,防止溢出与无限等待。
#[derive(Debug, Clone)]
pub struct DataSourceConfig {
    pub source_id: String,
    /// 离线缓存容量(最近 N 条环形);超限丢最旧并计数。
    pub cache_capacity: usize,
    /// 离线缓存字节预算;超限同样从最旧淘汰直到降到预算内。
    /// 与条数上限共同生效,谁先触顶谁淘汰。0 表示「只受条数约束」。
    /// 单条自身超预算时不入缓存(计入 `cache_oversized`),避免一条就把缓存撑爆。
    pub cache_byte_budget: usize,
    /// 静默窗口(毫秒):连接建立后允许的最长无活动时间;超时视为链路已死,
/// 关闭并进入指数退避。0 表示不设窗口。
///
/// 口径说明:同步 `Transport` 合同下 `connect()` 立即给出结果,不存在「握手中」
/// 可观察窗口,因此本窗口覆盖的是**连接建立后的静默期**(收不到数据/发送无响应)。
/// 真实异步握手接入后,同一字段同时覆盖握手驻留,状态机不变。
    pub idle_deadline_ms: u64,
    pub backoff_base_ms: u64,
    pub backoff_max_ms: u64,
}

impl DataSourceConfig {
    pub const MAX_CACHE_CAPACITY: usize = 65_536;
    pub const MAX_CACHE_BYTE_BUDGET: usize = 64 * 1024 * 1024;
    pub const MAX_IDLE_DEADLINE_MS: u64 = 600_000;
    pub const MAX_BACKOFF_MS: u64 = 86_400_000;

    pub fn validated(self) -> Result<Self, String> {
        if !stable_id(&self.source_id) {
            return Err("invalid data source identity".into());
        }
        if self.cache_capacity == 0 || self.cache_capacity > Self::MAX_CACHE_CAPACITY {
            return Err("data source cache capacity out of bounds".into());
        }
        if self.cache_byte_budget > Self::MAX_CACHE_BYTE_BUDGET {
            return Err("data source cache byte budget out of bounds".into());
        }
        if self.idle_deadline_ms > Self::MAX_IDLE_DEADLINE_MS {
            return Err("data source idle deadline out of bounds".into());
        }
        if self.backoff_base_ms == 0
            || self.backoff_base_ms > self.backoff_max_ms
            || self.backoff_max_ms > Self::MAX_BACKOFF_MS
        {
            return Err("data source backoff window out of bounds".into());
        }
        Ok(self)
    }
}

/// 注入式传输合同:连接/发送返回即时结果,接收由宿主泵入 `on_receive`。
/// Mock 实现用固定脚本;真实实现(受控 HTTP/订阅 + host 注入凭据)后续接入。
pub trait Transport {
    fn connect(&mut self) -> TransportOutcome;
    fn send(&mut self, bytes: &[u8]) -> TransportOutcome;
    /// 关闭在途连接;实现必须幂等。
    fn close(&mut self);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportOutcome {
    Up,
    Down(TransportFailure),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportFailure {
    Timeout,
    Unavailable(String),
}

impl TransportFailure {
    fn phrase(&self) -> String {
        match self {
            Self::Timeout => "timed out".into(),
            Self::Unavailable(reason) => format!("unavailable: {reason}"),
        }
    }
}

/// 同步合同下 `Connecting` 为瞬时态(真实异步绑定切片将在此驻留等待握手结果)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataSourceState {
    Disconnected,
    Connecting,
    Connected,
    Retrying { attempt: u32, due_ms: u64 },
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiveVerdict {
    /// 版本推进、入缓存,负载交宿主喂 chart(经 `payload_to_chart_message`)。
    Delivered(DataSourcePayload),
    DroppedStaleVersion,
    DroppedWrongSource,
    DroppedOffline,
    RejectedClosed,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DataSourceCounters {
    /// 迟到或重复(<= 已提交)版本被丢弃的次数。
    pub stale_dropped: u64,
    /// source 身份不匹配(防串源)拒绝次数。
    pub wrong_source: u64,
    /// 非连接态收到数据被丢弃次数。
    pub offline_receive_dropped: u64,
    /// 非连接态尝试发送被拒绝次数。
    pub send_rejected: u64,
    /// 离线缓存超限淘汰最旧条数(条数或字节任一触顶)。
    pub cache_evicted: u64,
    /// 单条负载自身即超字节预算、被拒绝入缓存的次数。
    pub cache_oversized: u64,
    /// 静默窗口到期、由宿主 `poll_idle_deadline` 收口的次数。
    pub idle_timeouts: u64,
    /// 重试调度次数(含首次失败)。
    pub retries_scheduled: u64,
}

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

    /// 宿主静默检测泵:Connected 且静默超过 `idle_deadline_ms` 时,视为链路已死,
    /// 关闭并进入指数退避。返回是否触发了本次收口。
    ///
    /// 未设窗口或不在连接态时是空操作(返回 false),宿主可逐帧无条件调用。
    /// 这是「同步 Transport 下无法观察握手驻留」的补偿:静默期本就是最需要探测的死链。
    pub fn poll_idle_deadline(&mut self, now_ms: u64) -> bool {
        if self.state != DataSourceState::Connected || self.config.idle_deadline_ms == 0 {
            return false;
        }
        let Some(last) = self.last_activity_ms else {
            return false;
        };
        let due = last.saturating_add(self.config.idle_deadline_ms);
        if now_ms < due {
            return false;
        }
        self.transport.close();
        self.schedule_retry(now_ms, 0, "idle deadline exceeded");
        self.counters.idle_timeouts = self.counters.idle_timeouts.saturating_add(1);
        true
    }

    /// 收回在途 deadline 的观察口径(供宿主诊断):Connected 时返回静默到期时刻。
    pub fn idle_deadline(&self) -> Option<u64> {
        if self.state != DataSourceState::Connected || self.config.idle_deadline_ms == 0 {
            return None;
        }
        self.last_activity_ms
            .map(|last| last.saturating_add(self.config.idle_deadline_ms))
    }

    /// 断线恢复后的续传对接点:返回缓存中 sourceVersion > watermark 的负载(按序克隆)。
    /// watermark 由宿主按「已确认消化进 chart 的源版本」给定,与 `committed_source_version`
    /// (最新接收版本)解耦;重放负载仍须逐条过 `payload_to_chart_message` 的 CAS 对接。
    pub fn cache_pending_after(&self, watermark: u64) -> Vec<DataSourcePayload> {
        self.cache
            .iter()
            .filter(|payload| payload.source_version > watermark)
            .cloned()
            .collect()
    }

    /// connect 事件:仅 Disconnected / 退避到期的 Retrying 可发起;
    /// 结果经注入 Transport 同步解析为 Connected 或 Retrying(指数退避)。
    pub fn connect(&mut self, now_ms: u64) -> Result<(), String> {
        let prior_attempt = match &self.state {
            DataSourceState::Closed => return Err("data source closed".into()),
            DataSourceState::Connecting | DataSourceState::Connected => {
                return Err("data source already connecting or connected".into());
            }
            DataSourceState::Retrying { attempt, due_ms } if now_ms < *due_ms => {
                return Err(format!("retry backoff pending until {due_ms} ms"));
            }
            DataSourceState::Retrying { attempt, .. } => Some(*attempt),
            DataSourceState::Disconnected => None,
        };
        self.state = DataSourceState::Connecting;
        match self.transport.connect() {
            TransportOutcome::Up => {
                self.state = DataSourceState::Connected;
                // 连接建立即起算静默窗口:此后的活动由收发事件刷新。
                self.last_activity_ms = Some(now_ms);
                Ok(())
            }
            TransportOutcome::Down(failure) => {
                let phrase = failure.phrase();
                self.schedule_retry(now_ms, prior_attempt.unwrap_or(0), &phrase);
                Err(format!("data source connect {phrase}"))
            }
        }
    }

    /// send 事件:仅 Connected 可发;发送失败视为连接失效,掉线进 Retrying。
    pub fn send(&mut self, bytes: &[u8], now_ms: u64) -> Result<(), String> {
        if self.state != DataSourceState::Connected {
            self.counters.send_rejected += 1;
            let state = format!("{:?}", self.state);
            return Err(format!("data source send rejected in state {state}"));
        }
        match self.transport.send(bytes) {
            TransportOutcome::Up => {
                self.last_activity_ms = Some(now_ms);
                Ok(())
            }
            TransportOutcome::Down(failure) => {
                let phrase = failure.phrase();
                self.transport.close();
                self.schedule_retry(now_ms, 0, &phrase);
                Err(format!("data source send {phrase}"))
            }
        }
    }

    /// receive 事件:拒绝顺序为 终态 → 离线 → 串源 → 迟到,只有全部通过才推进版本、
    /// 入缓存并交付;被拒负载一律不回调数据。
    ///
    /// 无时间戳重载:不刷新静默窗口(既有调用方零改动)。需要宿主静默检测时用
    /// `on_receive_at`。
    pub fn on_receive(&mut self, payload: DataSourcePayload) -> ReceiveVerdict {
        self.on_receive_inner(payload, None)
    }

    /// 带时间戳的 receive:被接受的负载同时刷新静默窗口。
    pub fn on_receive_at(&mut self, payload: DataSourcePayload, now_ms: u64) -> ReceiveVerdict {
        self.on_receive_inner(payload, Some(now_ms))
    }

    fn on_receive_inner(
        &mut self,
        payload: DataSourcePayload,
        now_ms: Option<u64>,
    ) -> ReceiveVerdict {
        if self.state == DataSourceState::Closed {
            return ReceiveVerdict::RejectedClosed;
        }
        if self.state != DataSourceState::Connected {
            self.counters.offline_receive_dropped += 1;
            return ReceiveVerdict::DroppedOffline;
        }
        if payload.source_id != self.config.source_id {
            self.counters.wrong_source += 1;
            return ReceiveVerdict::DroppedWrongSource;
        }
        if self
            .committed_version
            .is_some_and(|committed| payload.source_version <= committed)
        {
            self.counters.stale_dropped += 1;
            return ReceiveVerdict::DroppedStaleVersion;
        }
        self.committed_version = Some(payload.source_version);
        if let Some(now_ms) = now_ms {
            self.last_activity_ms = Some(now_ms);
        }
        let delivered = payload.clone();
        let incoming = payload_bytes(&payload);
        // 单条超预算:整条不入缓存(仍交付),避免一条撑爆缓存或导致其余全被淘汰。
        if self.config.cache_byte_budget > 0 && incoming > self.config.cache_byte_budget {
            self.counters.cache_oversized += 1;
            return ReceiveVerdict::Delivered(delivered);
        }
        self.cache.push_back(payload);
        self.cache_bytes += incoming;
        // 条数与字节双约束:谁先触顶谁淘汰,直到两者都在界内。
        while self.cache.len() > self.config.cache_capacity
            || (self.config.cache_byte_budget > 0
                && self.cache_bytes > self.config.cache_byte_budget)
        {
            let Some(oldest) = self.cache.pop_front() else {
                break;
            };
            self.cache_bytes = self.cache_bytes.saturating_sub(payload_bytes(&oldest));
            self.counters.cache_evicted += 1;
        }
        ReceiveVerdict::Delivered(delivered)
    }

    /// timeout 事件:宿主检测到在途连接(或等待中的握手)超时 → 关闭并调度重试;
    /// 无在途连接时超时是宿主调度错误,显式报错不静默。
    pub fn on_timeout(&mut self, now_ms: u64) -> Result<(), String> {
        match self.state {
            DataSourceState::Closed => Err("data source closed".into()),
            DataSourceState::Connecting | DataSourceState::Connected => {
                self.transport.close();
                self.schedule_retry(now_ms, 0, "timed out");
                Ok(())
            }
            DataSourceState::Disconnected | DataSourceState::Retrying { .. } => {
                Err("no connection attempt in flight".into())
            }
        }
    }

    /// error 事件:传输层报告错误(Connected 中掉线、握手中失败)→ 关闭并调度重试。
    pub fn on_error(&mut self, reason: &str, now_ms: u64) -> Result<(), String> {
        match self.state {
            DataSourceState::Closed => Err("data source closed".into()),
            DataSourceState::Connecting | DataSourceState::Connected => {
                self.transport.close();
                self.schedule_retry(now_ms, 0, reason);
                Ok(())
            }
            DataSourceState::Disconnected | DataSourceState::Retrying { .. } => {
                Err("no connection to fail".into())
            }
        }
    }

    /// 退避到期自动重连;返回是否发起了本次尝试(now == due 视为到期),
    /// 尝试结果(Connected/继续退避)经 `state()` 观察。
    /// 重连成功后按 `idle_deadline_ms` 重新起算静默窗口。
    pub fn poll_retry(&mut self, now_ms: u64) -> bool {
        let due =
            matches!(self.state, DataSourceState::Retrying { due_ms, .. } if now_ms >= due_ms);
        if !due {
            return false;
        }
        let _ = self.connect(now_ms);
        true
    }

    /// cancel 事件:任意状态进入 Closed 终态,幂等;Closed 后一切事件被拒。
    pub fn cancel(&mut self) {
        if self.state != DataSourceState::Closed {
            self.transport.close();
            self.state = DataSourceState::Closed;
            self.last_activity_ms = None;
        }
    }

    /// 指数退避:delay = min(base << attempt, max),移位饱和防溢出。
    fn schedule_retry(&mut self, now_ms: u64, prior_attempt: u32, cause: &str) {
        let attempt = prior_attempt.saturating_add(1);
        let shift = prior_attempt.min(31);
        let delay = self
            .config
            .backoff_base_ms
            .checked_shl(shift)
            .unwrap_or(self.config.backoff_max_ms);
        let delay = delay.min(self.config.backoff_max_ms);
        let due_ms = now_ms.checked_add(delay).unwrap_or(u64::MAX);
        self.state = DataSourceState::Retrying { attempt, due_ms };
        // 已不在连接态:静默窗口失效,等 poll_retry 重连成功后再起算。
        self.last_activity_ms = None;
        self.counters.retries_scheduled = self.counters.retries_scheduled.saturating_add(1);
        self.last_failure = Some(cause.to_string());
    }
}

/// 单条负载的缓存占用字节:负载 + source 身份(与真实内存占用口径一致,
/// 不含 Vec/String 的分配器开销,与 P1-07 的 payload 记账同一口径)。
fn payload_bytes(payload: &DataSourcePayload) -> usize {
    payload.bytes.len() + payload.source_id.len()
}

/// 数据负载 → ChartDataMessage 的透传适配:复用 `parse_chart_data_update` 的合同解析,
/// 不解读业务语义;唯一改写是 CAS 对接——以宿主 runtime 当前 data_revision 重写
/// expected/data_revision,使 `ChartRuntime::apply_data_message` 的 CAS 判定成立
/// (源消息自带 revision 仅是传输层记录,跨断线重连后不可信)。
pub fn payload_to_chart_message(
    payload: &DataSourcePayload,
    current_data_revision: u64,
) -> Result<ChartDataMessage, String> {
    if payload.bytes.len() > CHART_DATA_MESSAGE_MAX_BYTES {
        return Err("data source payload exceeds 16 MiB".into());
    }
    let mut message = parse_chart_data_update(&payload.bytes)?;
    message.expected_data_revision = current_data_revision;
    message.data_revision = current_data_revision
        .checked_add(1)
        .filter(|revision| *revision <= 9_007_199_254_740_991)
        .ok_or("chart data revision exhausted")?;
    Ok(message)
}

#[cfg(test)]
#[path = "data_source_tests.rs"]
mod tests;
