use crate::chart::interaction_contract::stable_id;

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
    pub(super) fn phrase(&self) -> String {
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
