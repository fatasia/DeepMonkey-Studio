use super::*;

impl<T: Transport> DataSourceMachine<T> {
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
}
