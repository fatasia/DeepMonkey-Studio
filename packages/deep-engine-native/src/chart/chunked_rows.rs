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
        if overflow > 0
            && let Some(front) = self.chunks.first_mut()
        {
            let front = Arc::make_mut(front);
            let cut = overflow.min(front.rows.len());
            front.rows.drain(..cut);
            front.start += cut;
            self.head_start = front.start;
            dropped += cut;
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
#[path = "chunked_rows_tests.rs"]
mod tests;
