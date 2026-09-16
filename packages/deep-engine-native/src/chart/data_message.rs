use super::{
    CHART_BUDGETS, ChartDataUpdate, ChartDataUpdateEvidence, ChartRuntime, DatasetRowsUpdate,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const CHART_DATA_MESSAGE_MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDataMessage {
    pub schema: String,
    pub schema_version: u32,
    pub chart_id: String,
    pub expected_data_revision: u64,
    pub data_revision: u64,
    pub datasets: Vec<DatasetRowsUpdate>,
}

pub fn parse_chart_data_update(bytes: &[u8]) -> Result<ChartDataMessage, String> {
    if bytes.len() > CHART_DATA_MESSAGE_MAX_BYTES {
        return Err("chart data message exceeds 16 MiB".into());
    }
    let mut value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    super::reader::json_budget(&value, "$", 0, &mut 0).map_err(|error| format!("{error:?}"))?;
    if let Some(root) = value.as_object_mut() {
        for key in ["schemaVersion", "expectedDataRevision", "dataRevision"] {
            if let Some(value) = root.get_mut(key) {
                normalize_integer(value);
            }
        }
        if let Some(updates) = root
            .get_mut("datasets")
            .and_then(|value| value.as_array_mut())
        {
            for update in updates {
                if let Some(value) = update.get_mut("maxRows") {
                    normalize_integer(value);
                }
            }
        }
    }
    let message: ChartDataMessage =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    message.validate()?;
    Ok(message)
}

pub(super) fn normalize_integer(value: &mut serde_json::Value) {
    if value.as_u64().is_none()
        && let Some(number) = value.as_f64()
        && number >= 0.0
        && number <= 9_007_199_254_740_991.0
        && number.fract() == 0.0
    {
        *value = serde_json::json!(number as u64);
    }
}

impl ChartDataMessage {
    fn validate(&self) -> Result<(), String> {
        if self.schema != "deep-engine.chart-data-update"
            || self.schema_version != 1
            || !super::interaction_contract::stable_id(&self.chart_id)
            || self.expected_data_revision.checked_add(1) != Some(self.data_revision)
            || self.data_revision > 9_007_199_254_740_991
        {
            return Err("invalid chart data schema, identity or revision".into());
        }
        if self.datasets.is_empty() || self.datasets.len() > CHART_BUDGETS.datasets {
            return Err("invalid dataset batch size".into());
        }
        let mut ids = HashSet::new();
        for update in &self.datasets {
            let (id, rows) = match update {
                DatasetRowsUpdate::Replace { dataset_id, rows } => (dataset_id, rows),
                DatasetRowsUpdate::AppendWindow {
                    dataset_id,
                    rows,
                    max_rows,
                } => {
                    if *max_rows == 0 || *max_rows > CHART_BUDGETS.rows {
                        return Err("invalid chart window limit".into());
                    }
                    (dataset_id, rows)
                }
            };
            if !super::interaction_contract::stable_id(id) || !ids.insert(id) {
                return Err("invalid or repeated chart dataset identity".into());
            }
            if rows.len() > CHART_BUDGETS.rows
                || rows.iter().any(|row| {
                    row.len() > CHART_BUDGETS.dimensions
                        || row.iter().any(|value| {
                            value.is_object()
                                || value.is_array()
                                || value.as_str().is_some_and(|text| {
                                    text.encode_utf16().count() > CHART_BUDGETS.string_code_units
                                })
                        })
                })
            {
                return Err("invalid chart data row budget or scalar value".into());
            }
        }
        Ok(())
    }
}

impl ChartRuntime {
    pub fn apply_data_message(
        &mut self,
        message: ChartDataMessage,
    ) -> Result<ChartDataUpdateEvidence, String> {
        message.validate()?;
        if message.chart_id != self.source().id {
            return Err("chart data message belongs to another chart".into());
        }
        self.update_data(ChartDataUpdate {
            expected_data_revision: message.expected_data_revision,
            data_revision: message.data_revision,
            datasets: message.datasets,
        })
    }
}
