//! One immutable source borrow bounds the cache to one frame/generation.
use super::{ChartIR, ChartSeries, cartesian::shared_axis_values};
use std::{collections::HashMap, sync::Arc};
const MAX_AXIS_CACHE_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct FrameAxisValues<'a> {
    pub(super) source: &'a ChartIR,
    values: HashMap<(Option<String>, bool), Arc<[f64]>>,
    bytes: usize,
    budget: usize,
}

impl<'a> FrameAxisValues<'a> {
    pub(super) fn new(source: &'a ChartIR) -> Self {
        Self {
            source,
            values: HashMap::new(),
            bytes: 0,
            budget: MAX_AXIS_CACHE_BYTES,
        }
    }

    pub(super) fn get(&mut self, series: &ChartSeries, horizontal: bool) -> Arc<[f64]> {
        let axis = if horizontal {
            &series.x_axis_id
        } else {
            &series.y_axis_id
        };
        let key = (axis.clone(), horizontal);
        if let Some(values) = self.values.get(&key) {
            return values.clone();
        }
        let values: Arc<[f64]> = shared_axis_values(self.source, series, horizontal).into();
        let bytes = std::mem::size_of_val(values.as_ref());
        if let Some(next_bytes) = self.bytes.checked_add(bytes)
            && next_bytes <= self.budget
        {
            self.bytes = next_bytes;
            self.values.insert(key, values.clone());
        }
        // Oversized domains stay correct, simply without retention between series.
        values
    }

    #[cfg(test)]
    pub(super) fn with_budget(source: &'a ChartIR, budget: usize) -> Self {
        Self {
            budget,
            ..Self::new(source)
        }
    }
}
