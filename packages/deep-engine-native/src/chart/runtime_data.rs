use super::{ChartRuntime, clear_hover};
use crate::chart::{CHART_BUDGETS, ChartGeometryFrame, ChartValue, validate_chart_ir};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

/// Typed host command; external transports must validate their own envelope before calling this API.
pub struct ChartDataUpdate {
    pub expected_data_revision: u64,
    pub data_revision: u64,
    pub datasets: Vec<DatasetRowsUpdate>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DatasetRowsUpdate {
    Replace {
        dataset_id: String,
        rows: Vec<Vec<ChartValue>>,
    },
    AppendWindow {
        dataset_id: String,
        rows: Vec<Vec<ChartValue>>,
        max_rows: usize,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct ChartDataUpdateEvidence {
    pub data_revision: u64,
    pub changed_datasets: Vec<String>,
    pub affected_series: Vec<String>,
    pub evicted_rows: usize,
    pub geometry_rebuilt: bool,
}

impl ChartRuntime {
    /// One candidate owns new data, reconciled row identities and the complete paint/hit frame.
    /// A failed command never advances either revision. Hosts GPU-stage a clone before publishing it.
    pub fn update_data(
        &mut self,
        update: ChartDataUpdate,
    ) -> Result<ChartDataUpdateEvidence, String> {
        if update.expected_data_revision != self.data_revision
            || self.data_revision.checked_add(1) != Some(update.data_revision)
            || update.data_revision > 9_007_199_254_740_991
        {
            return Err("chart data update has a stale or invalid revision".into());
        }
        if update.datasets.is_empty() || update.datasets.len() > CHART_BUDGETS.datasets {
            return Err("chart data update requires a bounded nonempty dataset batch".into());
        }
        let mut ids = HashSet::new();
        let mut changes = Vec::new();
        let mut mappings = HashMap::new();
        let mut evicted_rows = 0;
        for update in update.datasets {
            let (id, incoming, limit) = match update {
                DatasetRowsUpdate::Replace { dataset_id, rows } => (dataset_id, rows, None),
                DatasetRowsUpdate::AppendWindow {
                    dataset_id,
                    rows,
                    max_rows,
                } => (dataset_id, rows, Some(max_rows)),
            };
            if !ids.insert(id.clone()) {
                return Err("duplicate dataset in chart data update".into());
            }
            let index = self
                .source
                .datasets
                .iter()
                .position(|dataset| dataset.id == id)
                .ok_or_else(|| format!("unknown chart dataset: {id}"))?;
            let old = &self.source.datasets[index];
            validate_rows(&incoming, old.dimensions.len())?;
            let (rows, mapping, dropped) = if let Some(limit) = limit {
                if limit == 0 || limit > CHART_BUDGETS.rows {
                    return Err("invalid chart window row limit".into());
                }
                if incoming.is_empty() && old.rows.len() <= limit {
                    continue;
                }
                let total = old
                    .rows
                    .len()
                    .checked_add(incoming.len())
                    .ok_or("chart row count overflow")?;
                let dropped = total.saturating_sub(limit);
                let mut rows = Vec::with_capacity(total.min(limit));
                rows.extend(old.rows.iter().skip(dropped).cloned());
                rows.extend(
                    incoming
                        .into_iter()
                        .skip(dropped.saturating_sub(old.rows.len())),
                );
                (
                    rows,
                    RowMapping::Shift {
                        removed: dropped,
                        old_len: old.rows.len(),
                    },
                    dropped.min(old.rows.len()),
                )
            } else {
                (incoming, RowMapping::Replace, old.rows.len())
            };
            // Identical replacement has no semantic row change; append/eviction still changes identity.
            let identity_changed =
                matches!(mapping, RowMapping::Shift { removed, .. } if removed > 0);
            let same_rows = rows.len() == old.rows.len()
                && rows.iter().zip(&old.rows).all(|(a, b)| {
                    a.len() == b.len()
                        && a.iter()
                            .zip(b)
                            .all(|(a, b)| crate::chart::value_equal::same_value(a, b))
                });
            if !same_rows || identity_changed {
                evicted_rows += dropped;
                mappings.insert(id, mapping);
                changes.push((index, rows));
            }
        }
        let changed_datasets = self
            .source
            .datasets
            .iter()
            .filter(|dataset| mappings.contains_key(&dataset.id))
            .map(|dataset| dataset.id.clone())
            .collect::<Vec<_>>();
        let series_mappings = self
            .source
            .series
            .iter()
            .filter_map(|series| {
                mappings
                    .get(&series.dataset_id)
                    .map(|mapping| (series.id.clone(), *mapping))
            })
            .collect::<HashMap<_, _>>();
        let affected_series = self
            .source
            .series
            .iter()
            .filter(|series| series_mappings.contains_key(&series.id))
            .map(|series| series.id.clone())
            .collect::<Vec<_>>();
        let geometry_rebuilt = affected_series
            .iter()
            .any(|id| !self.state.hidden_series.contains(id));
        let revision = self.next_revision()?;
        if !changes.is_empty() {
            let mut source = (*self.source).clone();
            for (index, rows) in changes {
                source.datasets[index].rows = rows.into();
            }
            reconcile_initial_actions(&mut source, &series_mappings);
            let validation = validate_chart_ir(&source);
            if !validation.valid {
                return Err(format!("chart data candidate invalid: {validation:?}"));
            }
            let mut state = self.state.clone();
            clear_hover(&mut state);
            state.selected = state
                .selected
                .into_iter()
                .filter_map(|(id, row)| match (series_mappings.get(&id), row) {
                    (Some(mapping), Some(row)) => mapping.row(row).map(|row| (id, Some(row))),
                    _ => Some((id, row)),
                })
                .collect();
            for (id, mapping) in &series_mappings {
                state.emphasis.remap_rows(id, |row| mapping.row(row));
            }
            let frame = if geometry_rebuilt {
                let mut frame = ChartGeometryFrame::prepare_incremental(
                    &source,
                    &state,
                    self.width,
                    self.height,
                    Some(&self.frame),
                    &changed_datasets,
                )?;
                frame.set_revision(revision);
                Some(Arc::new(frame))
            } else {
                None
            };
            self.source = Arc::new(source);
            self.state = state;
            if let Some(frame) = frame {
                self.frame = frame;
            }
        }
        self.data_revision = update.data_revision;
        self.revision = revision;
        Ok(ChartDataUpdateEvidence {
            data_revision: self.data_revision,
            changed_datasets,
            affected_series,
            evicted_rows,
            geometry_rebuilt,
        })
    }
}

#[derive(Clone, Copy)]
enum RowMapping {
    Replace,
    Shift { removed: usize, old_len: usize },
}
impl RowMapping {
    fn row(self, row: usize) -> Option<usize> {
        match self {
            Self::Replace => None,
            Self::Shift { removed, old_len } => {
                (row < old_len).then(|| row.checked_sub(removed)).flatten()
            }
        }
    }
}

fn validate_rows(rows: &[Vec<ChartValue>], dimensions: usize) -> Result<(), String> {
    if rows.len() > CHART_BUDGETS.rows {
        return Err("chart incoming rows exceed budget".into());
    }
    if rows.iter().any(|row| {
        row.len() != dimensions
            || row.iter().any(|value| {
                value.is_array()
                    || value.is_object()
                    || value
                        .as_str()
                        .is_some_and(|s| s.encode_utf16().count() > CHART_BUDGETS.string_code_units)
            })
    }) {
        return Err(
            "chart incoming rows require bounded scalar cells and matching dimensions".into(),
        );
    }
    Ok(())
}

fn reconcile_initial_actions(
    ir: &mut crate::chart::ChartIR,
    mappings: &HashMap<String, RowMapping>,
) {
    use crate::chart::interaction_contract::ChartInitialAction::*;
    ir.actions.retain_mut(|action| {
        let (series, row) = match action {
            Highlight {
                series_id,
                data_index,
            }
            | Downplay {
                series_id,
                data_index,
            }
            | Select {
                series_id,
                data_index,
            }
            | Unselect {
                series_id,
                data_index,
            } => (series_id, data_index),
            DataZoom { .. } => return true,
        };
        if let (Some(mapping), Some(index)) = (mappings.get(series), *row) {
            *row = mapping.row(index as usize).map(|index| index as u64);
            row.is_some()
        } else {
            true
        }
    });
}
