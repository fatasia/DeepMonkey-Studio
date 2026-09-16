//! P1-03: 混合值行的分块存储。与 C05 的 f64 `ChunkedSeries` 不同,本容器
//! 保留分类/中文/空值语义(`ChartValue` 原样存储);按行块 Arc 共享,滚动窗口
//! 整块淘汰,旧快照经 Arc 引用计数隔离与释放。本切片不替换 ChartIR 的
//! `ChartRows` JSON 合同,只作为数据通道的分块存储层。
//!
//! 预算语义与 C05 相反并有意为之:C05 是无窗口通道,超驻留即 fail-closed;
//! 本容器面向滚动窗口,`append_window` 的 `max_rows` 是**淘汰后驻留上限**,
//! 瞬时超额只限一个追加批次;`with_budget` 构造仍对初始行数 fail-closed。
use super::ChartValue;
use std::sync::Arc;

/// 每块行数:与 C05 数值通道的 8192 对齐;1M 行约 123 块,可独立淘汰。
pub const ROWS_PER_CHUNK: usize = 8_192;
/// 构造期硬驻留上限(与 IR 预算同量级)。
pub const MAX_RESIDENT_ROWS: usize = 524_288;

#[derive(Debug, Clone, PartialEq)]
pub struct ChunkedRows {
    max_rows: usize,
    chunks: Vec<Arc<RowsChunk>>,
    /// 首块全局起始行号;`head_start + total_rows` 恒等于末行绝对行号 + 1。
    head_start: usize,
    total_rows: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct RowsChunk {
    /// 全局起始行号(绝对),淘汰后不重排,用于窗口对齐与诊断。
    start: usize,
    rows: Vec<Vec<ChartValue>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkedRowsError {
    BudgetExceeded { requested: usize, cap: usize },
    EmptyChunk,
}

impl ChunkedRows {
    pub fn from_rows(rows: Vec<Vec<ChartValue>>) -> Result<Self, ChunkedRowsError> {
        Self::with_budget(rows, MAX_RESIDENT_ROWS)
    }

    /// 初始行数超出 `max_rows` 直接拒绝;内部按 ROWS_PER_CHUNK 切块。
    pub fn with_budget(
        rows: Vec<Vec<ChartValue>>,
        max_rows: usize,
    ) -> Result<Self, ChunkedRowsError> {
        if max_rows == 0 || rows.len() > max_rows {
            return Err(ChunkedRowsError::BudgetExceeded {
                requested: rows.len(),
                cap: max_rows,
            });
        }
        let mut chunks = Vec::new();
        for (index, block) in rows.chunks(ROWS_PER_CHUNK).enumerate() {
            if block.is_empty() {
                return Err(ChunkedRowsError::EmptyChunk);
            }
            chunks.push(Arc::new(RowsChunk {
                start: index * ROWS_PER_CHUNK,
                rows: block.to_vec(),
            }));
        }
        Ok(Self {
            max_rows,
            chunks,
            head_start: 0,
            total_rows: rows.len(),
        })
    }

    pub fn resident_rows(&self) -> usize {
        self.total_rows
    }
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }
    pub fn head_start(&self) -> usize {
        self.head_start
    }
    /// 逐块引用计数(诊断):证明淘汰后旧快照仍持有、未变块继续共享。
    pub fn chunk_strong_counts(&self) -> Vec<usize> {
        self.chunks.iter().map(Arc::strong_count).collect()
    }
    pub fn shares_chunk_storage_with(&self, other: &Self) -> bool {
        self.chunks.len() == other.chunks.len()
            && self
                .chunks
                .iter()
                .zip(&other.chunks)
                .all(|(left, right)| Arc::ptr_eq(left, right))
    }

    /// 滚动窗口追加:先整块追加,再从头部整块淘汰;窗口边界落在首块中间时,
    /// 仅该首块写时复制收缩,其余块继续与旧快照共享。返回淘汰行数。
    pub fn append_window(
        &mut self,
        new_rows: Vec<Vec<ChartValue>>,
        window: usize,
    ) -> Result<usize, ChunkedRowsError> {
        if window == 0 || new_rows.len() > self.max_rows {
            return Err(ChunkedRowsError::BudgetExceeded {
                requested: new_rows.len(),
                cap: self.max_rows,
            });
        }
        let window = window.min(self.max_rows);
        let end = self.head_start + self.total_rows;
        for (index, block) in new_rows.chunks(ROWS_PER_CHUNK).enumerate() {
            self.chunks.push(Arc::new(RowsChunk {
                start: end + index * ROWS_PER_CHUNK,
                rows: block.to_vec(),
            }));
        }
        self.total_rows += new_rows.len();
        Ok(self.evict_to_window(window))
    }

    /// 头部整块淘汰;仅当窗口边界落在首块中间时,写时复制分离首块裁掉超窗前缀,
    /// 证明其余块仍与旧快照共享。
    fn evict_to_window(&mut self, window: usize) -> usize {
        let mut dropped = 0usize;
        while self.chunks.len() > 1 {
            let front_rows = self.chunks[0].rows.len();
            if self.total_rows - dropped - front_rows >= window {
                let chunk = self.chunks.remove(0);
                self.head_start = chunk.start + chunk.rows.len();
                dropped += chunk.rows.len();
            } else {
                break;
            }
        }
        let keep = window.min(self.total_rows - dropped);
        let overflow = self.total_rows - dropped - keep;
        if overflow > 0 {
            if let Some(front) = self.chunks.first_mut() {
                let front = Arc::make_mut(front);
                let cut = overflow.min(front.rows.len());
                front.rows.drain(..cut);
                front.start += cut;
                self.head_start = front.start;
                dropped += cut;
            }
        }
        self.total_rows -= dropped;
        dropped
    }

    pub fn iter(&self) -> Iter<'_> {
        Iter {
            chunks: &self.chunks,
            chunk: 0,
            row: 0,
        }
    }
}

pub struct Iter<'a> {
    chunks: &'a [Arc<RowsChunk>],
    chunk: usize,
    row: usize,
}

impl<'a> Iterator for Iter<'a> {
    type Item = &'a Vec<ChartValue>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let chunk = self.chunks.get(self.chunk)?;
            if self.row < chunk.rows.len() {
                self.row += 1;
                return Some(&chunk.rows[self.row - 1]);
            }
            self.chunk += 1;
            self.row = 0;
        }
    }
}

impl<'a> IntoIterator for &'a ChunkedRows {
    type Item = &'a Vec<ChartValue>;
    type IntoIter = Iter<'a>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(index: usize) -> Vec<ChartValue> {
        // 混合语义:分类/中文/数值/null 同行共存。
        vec![
            json!(format!("设备-{index}")),
            json!(if index % 3 == 0 { "运行" } else { "备用" }),
            json!(index),
            json!(index as f64 * 0.5),
            json!(if index % 7 == 0 {
                serde_json::Value::Null
            } else {
                json!("中文标签")
            }),
        ]
    }

    fn mixed_rows(count: usize) -> Vec<Vec<ChartValue>> {
        (0..count).map(row).collect()
    }

    #[test]
    fn mixed_value_semantics_survive_chunking_and_iteration() {
        let rows = ChunkedRows::from_rows(mixed_rows(20)).unwrap();
        assert_eq!(rows.resident_rows(), 20);
        assert_eq!(rows.chunk_count(), 1);
        let collected: Vec<_> = rows.iter().collect();
        assert_eq!(collected.len(), 20);
        assert_eq!(collected[0][1], json!("运行"));
        assert_eq!(collected[7][4], serde_json::Value::Null);
        assert_eq!(collected[19][0], json!("设备-19"));
    }

    #[test]
    fn clone_shares_all_chunks_and_only_detached_chunk_copies_on_write() {
        let mut rows = ChunkedRows::from_rows(mixed_rows(20_000)).unwrap();
        let snapshot = rows.clone();
        assert!(rows.shares_chunk_storage_with(&snapshot));
        let before = snapshot.chunk_strong_counts();
        assert!(before.iter().all(|count| *count == 2));
        // 窗口 20000 内追加 10 行:首块被局部收缩(写时复制分离),其余块仍共享。
        rows.append_window(mixed_rows(10), 20_000).unwrap();
        let after = snapshot.chunk_strong_counts();
        assert_eq!(after[0], 1, "首块经写时复制与快照分离");
        assert_eq!((after[1], after[2]), (2, 2), "未变的块引用计数不变");
    }

    #[test]
    fn window_eviction_drops_whole_chunks_and_old_snapshot_keeps_its_rows() {
        let mut rows = ChunkedRows::from_rows(mixed_rows(20_000)).unwrap();
        let snapshot = rows.clone();
        rows.append_window(mixed_rows(16_000), 20_000).unwrap();
        assert_eq!(rows.resident_rows(), 20_000);
        assert_eq!(rows.head_start(), 16_000);
        assert!(rows.chunk_count() < snapshot.chunk_count() + 2);
        // 旧快照仍可完整遍历自己的 20000 行,块未被释放(Arc 持有)。
        assert_eq!(snapshot.resident_rows(), 20_000);
        assert_eq!(snapshot.iter().count(), 20_000);
        assert_eq!(snapshot.iter().next().unwrap()[0], json!("设备-0"));
        // 新容器的第一行是绝对行号 16000。
        assert_eq!(rows.iter().next().unwrap()[0], json!("设备-16000"));
    }

    #[test]
    fn partial_window_boundary_copies_only_the_front_chunk() {
        let mut rows = ChunkedRows::from_rows(mixed_rows(20_000)).unwrap();
        let snapshot = rows.clone();
        // 窗口 18000:整块淘汰后边界落在首块中间,首块写时复制收缩。
        rows.append_window(mixed_rows(9_000), 18_000).unwrap();
        assert_eq!(rows.resident_rows(), 18_000);
        let counts = rows.chunk_strong_counts();
        // 收缩后的首块已与旧快照分离(计数 1);原第三块仍共享(计数 2);新块计数 1。
        assert_eq!(counts[0], 1, "front chunk must detach");
        assert_eq!(counts[1], 2, "untouched original chunk stays shared");
        assert!(
            counts[2..].iter().all(|count| *count == 1),
            "fresh chunks are exclusively owned"
        );
        assert_eq!(snapshot.iter().count(), 20_000);
        assert_eq!(rows.iter().next().unwrap()[0], json!("设备-11000"));
    }

    #[test]
    fn budget_fails_closed_without_silent_eviction_on_construction() {
        assert_eq!(
            ChunkedRows::with_budget(mixed_rows(25_000), 20_000),
            Err(ChunkedRowsError::BudgetExceeded {
                requested: 25_000,
                cap: 20_000
            })
        );
        let empty = ChunkedRows::from_rows(vec![]).unwrap();
        assert_eq!(empty.resident_rows(), 0);
        let mut rows = ChunkedRows::with_budget(mixed_rows(1_000), 1_000).unwrap();
        assert_eq!(
            rows.append_window(mixed_rows(2_000), 1_000),
            Err(ChunkedRowsError::BudgetExceeded {
                requested: 2_000,
                cap: 1_000
            })
        );
        // 含 null 值的单行是合法混合语义,原样入库。
        rows.append_window(vec![vec![serde_json::Value::Null]], 1_000)
            .unwrap();
        assert_eq!(rows.resident_rows(), 1_000);
        assert_eq!(rows.iter().last().unwrap()[0], serde_json::Value::Null);
    }
}
