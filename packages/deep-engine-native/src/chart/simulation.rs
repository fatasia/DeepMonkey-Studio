use super::{ChartDataMessage, ChartRuntime, DatasetRowsUpdate};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartSimFixture {
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub chart_id: String,
    pub dataset_id: String,
    pub dimensions: Vec<String>,
    pub rows: Vec<Vec<super::ChartValue>>,
    pub seed: u32,
    pub interval_ms: u64,
    pub start_time_ms: u64,
    pub max_rows: usize,
}

pub fn parse_chart_sim_fixture(bytes: &[u8]) -> Result<ChartSimFixture, String> {
    if bytes.len() > super::CHART_DATA_MESSAGE_MAX_BYTES {
        return Err("sim fixture exceeds 16 MiB".into());
    }
    let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    super::reader::json_budget(&value, "$", 0, &mut 0).map_err(|e| format!("{e:?}"))?;
    if let Some(root) = value.as_object_mut() {
        for key in [
            "schemaVersion",
            "seed",
            "intervalMs",
            "startTimeMs",
            "maxRows",
        ] {
            if let Some(value) = root.get_mut(key) {
                super::data_message::normalize_integer(value);
            }
        }
    }
    serde_json::from_value(value).map_err(|e| e.to_string())
}

/// Fixed-step cyclic playback of validated fixture rows, rotated by seed.
/// No wall clock, network, random host state or background callbacks are accessed here.
pub struct ChartSimulationSource {
    identity: Arc<()>,
    fixture: ChartSimFixture,
    next_tick: u64,
    cancelled: bool,
}

pub struct ChartSimFrame {
    identity: Arc<()>,
    tick: u64,
    pub captured_at_ms: u64,
    message: ChartDataMessage,
}
impl ChartSimFrame {
    pub fn message(&self) -> &ChartDataMessage {
        &self.message
    }
}

impl ChartSimulationSource {
    pub fn new(fixture: ChartSimFixture, chart: &ChartRuntime) -> Result<Self, String> {
        if fixture.schema != "deep-engine.chart-sim"
            || fixture.schema_version != 1
            || !super::interaction_contract::stable_id(&fixture.id)
            || fixture.chart_id != chart.source().id
            || fixture.rows.is_empty()
            || fixture.interval_ms == 0
            || fixture.interval_ms > 86_400_000
            || fixture.start_time_ms > 9_007_199_254_740_991
        {
            return Err("invalid sim fixture identity, clock or rows".into());
        }
        let dataset = chart
            .source()
            .datasets
            .iter()
            .find(|d| d.id == fixture.dataset_id)
            .ok_or("sim dataset missing")?;
        if dataset.dimensions != fixture.dimensions {
            return Err("sim dimensions do not match the chart".into());
        }
        // Validate all rows, including those not sampled in the first window.
        let mut candidate = chart.clone();
        let next_revision = chart
            .data_revision()
            .checked_add(1)
            .ok_or("sim data revision exhausted")?;
        candidate.apply_data_message(ChartDataMessage {
            schema: "deep-engine.chart-data-update".into(),
            schema_version: 1,
            chart_id: fixture.chart_id.clone(),
            expected_data_revision: chart.data_revision(),
            data_revision: next_revision,
            datasets: vec![DatasetRowsUpdate::AppendWindow {
                dataset_id: fixture.dataset_id.clone(),
                rows: fixture.rows.clone(),
                max_rows: fixture.max_rows,
            }],
        })?;
        Ok(Self {
            identity: Arc::new(()),
            fixture,
            next_tick: 0,
            cancelled: false,
        })
    }

    pub fn interval_ms(&self) -> u64 {
        self.fixture.interval_ms
    }
    /// 取消即终态:没有下一次到期,调用方必须停止调度而不是拿到可等待的时刻。
    pub fn next_due_ms(&self) -> Result<u64, String> {
        if self.cancelled {
            return Err("sim source cancelled".into());
        }
        self.next_tick
            .checked_mul(self.fixture.interval_ms)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or_else(|| "sim clock exhausted".into())
    }
    pub fn cancel(&mut self) {
        self.cancelled = true;
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    /// Preparing or retrying a frame does not consume its tick. Commit only after the chart/GPU transaction succeeds.
    pub fn prepare(
        &self,
        elapsed_ms: u64,
        data_revision: u64,
    ) -> Result<Option<ChartSimFrame>, String> {
        if self.cancelled {
            return Ok(None);
        }
        if elapsed_ms > 9_007_199_254_740_991 {
            return Err("invalid sim elapsed time".into());
        }
        if elapsed_ms < self.next_due_ms()? {
            return Ok(None);
        }
        let captured_at_ms = self
            .fixture
            .start_time_ms
            .checked_add(self.next_due_ms()?)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or("sim timestamp exhausted")?;
        let next_revision = data_revision
            .checked_add(1)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or("sim data revision exhausted")?;
        let count = self.fixture.rows.len() as u64;
        let row =
            ((u64::from(self.fixture.seed) % count + self.next_tick % count) % count) as usize;
        Ok(Some(ChartSimFrame {
            identity: self.identity.clone(),
            tick: self.next_tick,
            captured_at_ms,
            message: ChartDataMessage {
                schema: "deep-engine.chart-data-update".into(),
                schema_version: 1,
                chart_id: self.fixture.chart_id.clone(),
                expected_data_revision: data_revision,
                data_revision: next_revision,
                datasets: vec![DatasetRowsUpdate::AppendWindow {
                    dataset_id: self.fixture.dataset_id.clone(),
                    rows: vec![self.fixture.rows[row].clone()],
                    max_rows: self.fixture.max_rows,
                }],
            },
        }))
    }

    pub fn commit(&mut self, frame: ChartSimFrame, committed_revision: u64) -> Result<(), String> {
        if !Arc::ptr_eq(&self.identity, &frame.identity)
            || self.cancelled
            || frame.tick != self.next_tick
            || frame.message.data_revision != committed_revision
            || frame.message.chart_id != self.fixture.chart_id
        {
            return Err("stale, cancelled or uncommitted sim frame".into());
        }
        self.next_tick = self.next_tick.checked_add(1).ok_or("sim tick exhausted")?;
        Ok(())
    }
}
