use super::*;

impl<T: Transport> DataSourceMachine<T> {
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
    pub(super) fn schedule_retry(&mut self, now_ms: u64, prior_attempt: u32, cause: &str) {
        let attempt = prior_attempt.saturating_add(1);
        let shift = prior_attempt.min(31);
        let delay = self
            .config
            .backoff_base_ms
            .checked_shl(shift)
            .unwrap_or(self.config.backoff_max_ms);
        let delay = delay.min(self.config.backoff_max_ms);
        let due_ms = now_ms.saturating_add(delay);
        self.state = DataSourceState::Retrying { attempt, due_ms };
        // 已不在连接态:静默窗口失效,等 poll_retry 重连成功后再起算。
        self.last_activity_ms = None;
        self.counters.retries_scheduled = self.counters.retries_scheduled.saturating_add(1);
        self.last_failure = Some(cause.to_string());
    }
}
