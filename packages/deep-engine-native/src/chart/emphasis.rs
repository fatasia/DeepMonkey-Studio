//! 持久强调与瞬时悬停分离。整系列强调用默认值与例外集表示，不展开数据行。
use super::{ActionError, ChartIR, InteractionState};
use std::collections::{BTreeMap, BTreeSet};

impl InteractionState {
    pub fn set_emphasis(
        &mut self,
        ir: &ChartIR,
        series_id: &str,
        data_index: Option<usize>,
        enabled: bool,
    ) -> Result<(), ActionError> {
        validate_target(ir, series_id, data_index)?;
        self.emphasis.set(series_id, data_index, enabled);
        Ok(())
    }
}

pub(super) fn validate_target(
    ir: &ChartIR,
    series_id: &str,
    data_index: Option<usize>,
) -> Result<(), ActionError> {
    let series = ir
        .series
        .iter()
        .find(|series| series.id == series_id)
        .ok_or(ActionError::UnknownSeries)?;
    let dataset = ir
        .datasets
        .iter()
        .find(|dataset| dataset.id == series.dataset_id)
        .ok_or(ActionError::InvalidDataIndex)?;
    if data_index.is_some_and(|index| index >= dataset.rows.len()) {
        return Err(ActionError::InvalidDataIndex);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct EmphasisState {
    series: BTreeMap<String, SeriesEmphasis>,
}

#[derive(Debug, Clone, PartialEq, Default)]
struct SeriesEmphasis {
    all: bool,
    exceptions: BTreeSet<usize>,
}

impl EmphasisState {
    pub(super) fn remap_rows(&mut self, series_id: &str, map: impl Fn(usize) -> Option<usize>) {
        if let Some(state) = self.series.get_mut(series_id) {
            state.exceptions = state
                .exceptions
                .iter()
                .filter_map(|index| map(*index))
                .collect();
            if !state.all && state.exceptions.is_empty() {
                self.series.remove(series_id);
            }
        }
    }
    /// A series-only surface cannot faithfully represent a subset of its rows.
    pub fn contains_entire_series(&self, series_id: &str) -> bool {
        self.series
            .get(series_id)
            .is_some_and(|state| state.all && state.exceptions.is_empty())
    }

    pub fn contains(&self, series_id: &str, data_index: usize) -> bool {
        self.series
            .get(series_id)
            .is_some_and(|state| state.all != state.exceptions.contains(&data_index))
    }

    /// 显式单行持久强调的 (series_id, row) 清单，按系列与行号确定序。
    ///
    /// 覆盖顺序合同：row 级强调强于系列级。系列级 `all` 只由系列轮廓表达
    /// （展开成逐行 marker 在大数据窗口会爆炸），显式单行强调额外产生
    /// row marker；系列级强调中显式 downplay 的行回到普通态（row 级覆盖
    /// 系列级）。后到的系列级动作重置该系列的例外集，行级信息随条目
    /// 一并消失。
    pub(super) fn row_markers(&self) -> Vec<(&str, usize)> {
        let mut rows = Vec::new();
        for (id, state) in &self.series {
            if state.all {
                continue;
            }
            for row in &state.exceptions {
                rows.push((id.as_str(), *row));
            }
        }
        rows
    }

    pub fn is_empty(&self) -> bool {
        self.series.is_empty()
    }

    pub(super) fn set(&mut self, series_id: &str, data_index: Option<usize>, enabled: bool) {
        if data_index.is_none() {
            if enabled {
                self.series.insert(
                    series_id.into(),
                    SeriesEmphasis {
                        all: true,
                        exceptions: BTreeSet::new(),
                    },
                );
            } else {
                self.series.remove(series_id);
            }
            return;
        }
        let index = data_index.unwrap();
        let state = self.series.entry(series_id.into()).or_default();
        if enabled == state.all {
            state.exceptions.remove(&index);
        } else {
            state.exceptions.insert(index);
        }
        if !state.all && state.exceptions.is_empty() {
            self.series.remove(series_id);
        }
    }
}
