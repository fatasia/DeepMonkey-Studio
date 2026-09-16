//! 数据快照共享未修改的行；可变访问只分离当前数据集，不复制其他数据集。
//! 纯行统计(有限性/正性/字符串预算)随不可变行存储惰性缓存;唯一可变入口
//! `DerefMut` 先分离再清缓存,保证任何写路径后统计自动失效、旧快照不受污染。
use super::types::{CHART_BUDGETS, ChartValue};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex},
};

/// 一次线性扫描得出的纯统计;语义校验据此免于重复扫描相同行。
#[derive(Debug, Default, PartialEq)]
pub struct RowStats {
    pub string_over_budget: bool,
    columns: Vec<ColumnStat>,
    max_row_len: usize,
    has_rows: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct ColumnStat {
    finite: bool,
    positive: bool,
}

impl RowStats {
    /// 该列所有行都是有限数值;空数据集等价于 `iter().any()` 为假,视为通过。
    pub fn column_is_finite(&self, column: usize) -> bool {
        if !self.has_rows {
            return true;
        }
        match self.columns.get(column) {
            Some(stat) => stat.finite,
            // 行宽都不足该列:每个 `row.get(column)` 均为 None,原判定为失败。
            None => false,
        }
    }

    /// 该列所有行都是有限正数(log 轴判定);空数据集视为通过。
    pub fn column_is_positive(&self, column: usize) -> bool {
        if !self.has_rows {
            return true;
        }
        match self.columns.get(column) {
            Some(stat) => stat.positive,
            None => false,
        }
    }
}

#[derive(Debug, Default)]
struct RowsInner {
    rows: Vec<Vec<ChartValue>>,
    stats: Mutex<Option<Arc<RowStats>>>,
}

impl Clone for RowsInner {
    fn clone(&self) -> Self {
        // Arc::make_mut 的分离克隆不继承统计:行已复制,统计必须重算。
        Self {
            rows: self.rows.clone(),
            stats: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChartRows(Arc<RowsInner>);

impl ChartRows {
    pub fn shares_storage_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// 惰性统计:首次调用线性扫描并缓存,之后 O(1);共享克隆复用同一份结果。
    pub fn stats(&self) -> Arc<RowStats> {
        if let Some(stats) = self.0.stats.lock().unwrap().clone() {
            return stats;
        }
        let stats = Arc::new(compute_stats(&self.0.rows));
        let mut guard = self.0.stats.lock().unwrap();
        if guard.is_none() {
            *guard = Some(stats.clone());
        }
        stats
    }

    /// 测试与基准观测:已缓存且未失效的统计。
    pub fn cached_stats(&self) -> Option<Arc<RowStats>> {
        self.0.stats.lock().unwrap().clone()
    }
}

fn compute_stats(rows: &[Vec<ChartValue>]) -> RowStats {
    let mut stats = RowStats {
        string_over_budget: false,
        columns: Vec::new(),
        max_row_len: rows.iter().map(Vec::len).max().unwrap_or(0),
        has_rows: !rows.is_empty(),
    };
    stats.columns.resize(
        stats.max_row_len,
        ColumnStat {
            finite: true,
            positive: true,
        },
    );
    for row in rows {
        // 行宽不足的列等价于缺单元格:原校验把 None 判为非有限/非正。
        for column in &mut stats.columns[row.len()..] {
            column.finite = false;
            column.positive = false;
        }
        for (index, value) in row.iter().enumerate() {
            let column = &mut stats.columns[index];
            match value.as_f64() {
                Some(number) if number.is_finite() => column.positive &= number > 0.0,
                _ => {
                    column.finite = false;
                    column.positive = false;
                }
            }
            if let Some(text) = value.as_str() {
                stats.string_over_budget |=
                    text.encode_utf16().count() > CHART_BUDGETS.string_code_units;
            }
        }
    }
    stats
}

impl PartialEq for ChartRows {
    fn eq(&self, other: &Self) -> bool {
        self.0.rows == other.0.rows
    }
}
impl From<Vec<Vec<ChartValue>>> for ChartRows {
    fn from(rows: Vec<Vec<ChartValue>>) -> Self {
        Self(Arc::new(RowsInner {
            rows,
            stats: Mutex::new(None),
        }))
    }
}
impl FromIterator<Vec<ChartValue>> for ChartRows {
    fn from_iter<T: IntoIterator<Item = Vec<ChartValue>>>(iter: T) -> Self {
        Vec::from_iter(iter).into()
    }
}
impl Deref for ChartRows {
    type Target = Vec<Vec<ChartValue>>;
    fn deref(&self) -> &Self::Target {
        &self.0.rows
    }
}
impl DerefMut for ChartRows {
    fn deref_mut(&mut self) -> &mut Self::Target {
        let inner = Arc::make_mut(&mut self.0);
        *inner.stats.lock().unwrap() = None;
        &mut inner.rows
    }
}
impl<'a> IntoIterator for &'a ChartRows {
    type Item = &'a Vec<ChartValue>;
    type IntoIter = std::slice::Iter<'a, Vec<ChartValue>>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}
impl Serialize for ChartRows {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.rows.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for ChartRows {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<Vec<ChartValue>>::deserialize(deserializer).map(Self::from)
    }
}
