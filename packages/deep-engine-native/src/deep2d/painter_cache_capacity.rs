//! 条目容量、LRU 淘汰与成功帧的删除清理。
use super::{Deep2dPathCache, Entry, MIN_EVICTED_MEMORY};
use std::collections::HashSet;

impl Deep2dPathCache {
    /// 成功准备显示列表后清理不再使用的路径。失败准备不执行删除清理，
    /// 但沿用既有规则：已准备命令仍可能更新纯缓存条目和命中统计。
    pub(in super::super) fn prune_to_ids<'a, I>(&mut self, ids: I)
    where
        I: IntoIterator<Item = &'a str>,
    {
        let live = ids.into_iter().collect::<HashSet<_>>();
        let stale = self
            .entries
            .keys()
            .filter(|id| !live.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        for id in stale {
            if let Some(entry) = self.entries.remove(&id) {
                self.stats.payload_bytes -= entry.bytes;
                self.order.remove(&(entry.touched, id.clone()));
                self.stats.deletions += 1;
            }
        }
        self.recently_evicted
            .retain(|id| live.contains(id.as_str()));
        self.stats.entries = self.entries.len();
    }

    pub(super) fn store(&mut self, id: String, entry: Entry) {
        if let Some(old) = self.entries.remove(&id) {
            self.stats.payload_bytes -= old.bytes;
            self.order.remove(&(old.touched, id.clone()));
        }
        while self.entries.len() >= self.max_entries
            || self.stats.payload_bytes + entry.bytes > self.max_bytes
        {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            let old = self.entries.remove(&oldest).unwrap();
            self.stats.payload_bytes -= old.bytes;
            self.stats.evictions += 1;
            self.remember_evicted(oldest);
        }
        self.stats.payload_bytes += entry.bytes;
        self.order.insert((entry.touched, id.clone()));
        self.recently_evicted.remove(&id);
        self.entries.insert(id, entry);
        self.stats.entries = self.entries.len();
    }

    // 同 id 重存(覆盖)不算逐出,只有上面的 LRU 循环才记入逐出记忆。
    fn remember_evicted(&mut self, id: String) {
        if self.recently_evicted.len() >= self.max_entries.max(MIN_EVICTED_MEMORY) {
            self.recently_evicted.clear();
        }
        self.recently_evicted.insert(id);
    }
}
