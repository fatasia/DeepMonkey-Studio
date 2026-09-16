use super::*;

impl<T: Transport> DataSourceMachine<T> {
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
}

/// 单条负载的缓存占用字节:负载 + source 身份(与真实内存占用口径一致,
/// 不含 Vec/String 的分配器开销,与 P1-07 的 payload 记账同一口径)。
fn payload_bytes(payload: &DataSourcePayload) -> usize {
    payload.bytes.len() + payload.source_id.len()
}
