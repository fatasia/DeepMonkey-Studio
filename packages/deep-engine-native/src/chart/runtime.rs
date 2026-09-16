//! Per-chart commit boundary for source, interaction and paint/hit geometry.
use super::{ChartAction, ChartGeometryFrame, ChartIR, InteractionState};
use std::sync::Arc;
#[path = "runtime_data.rs"]
mod data;
pub use data::{ChartDataUpdate, ChartDataUpdateEvidence, DatasetRowsUpdate};

#[derive(Clone)]
pub struct ChartRuntime {
    source: Arc<ChartIR>,
    state: InteractionState,
    frame: Arc<ChartGeometryFrame>,
    width: f64,
    height: f64,
    revision: u64,
    data_revision: u64,
}

impl ChartRuntime {
    pub fn new(source: ChartIR, width: f64, height: f64) -> Result<Self, String> {
        let state = InteractionState::from_ir(&source)
            .map_err(|error| format!("chart initialization: {error:?}"))?;
        let frame = ChartGeometryFrame::prepare(&source, &state, width, height)?;
        Ok(Self {
            source: Arc::new(source),
            state,
            frame: Arc::new(frame),
            width,
            height,
            revision: 0,
            data_revision: 0,
        })
    }
    pub fn source(&self) -> &ChartIR {
        &self.source
    }
    pub fn state(&self) -> &InteractionState {
        &self.state
    }
    pub fn frame(&self) -> &ChartGeometryFrame {
        &self.frame
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn data_revision(&self) -> u64 {
        self.data_revision
    }

    /// Non-geometric actions update state without rebuilding paths. Their
    /// tooltip/emphasis presentation is owned by the host overlay layer.
    pub fn dispatch(&mut self, action: ChartAction) -> Result<bool, String> {
        let mut candidate = self.state.clone();
        candidate
            .apply(&self.source, action)
            .map_err(|error| format!("chart action: {error:?}"))?;
        if candidate == self.state {
            return Ok(false);
        }
        let revision = self.next_revision()?;
        let geometry_changed = candidate.hidden_series != self.state.hidden_series
            || candidate.zoom_windows != self.state.zoom_windows;
        let frame = if geometry_changed {
            clear_hover(&mut candidate);
            let mut frame = ChartGeometryFrame::prepare_incremental(
                &self.source,
                &candidate,
                self.width,
                self.height,
                Some(&self.frame),
                &[],
            )?;
            frame.set_revision(revision);
            Some(frame)
        } else {
            None
        };
        self.state = candidate;
        if let Some(frame) = frame {
            self.frame = Arc::new(frame);
        }
        self.revision = revision;
        Ok(true)
    }

    pub fn resize(&mut self, width: f64, height: f64) -> Result<bool, String> {
        if width == self.width && height == self.height {
            return Ok(false);
        }
        let revision = self.next_revision()?;
        let mut candidate = self.state.clone();
        clear_hover(&mut candidate);
        let mut frame = ChartGeometryFrame::prepare_incremental(
            &self.source,
            &candidate,
            width,
            height,
            Some(&self.frame),
            &[],
        )?;
        frame.set_revision(revision);
        self.frame = Arc::new(frame);
        self.state = candidate;
        self.width = width;
        self.height = height;
        self.revision = revision;
        Ok(true)
    }

    /// Full replacement restarts authored initial actions; incremental data
    /// patches will use a separate reconciliation path.
    pub fn replace(&mut self, source: ChartIR) -> Result<(), String> {
        let revision = self.next_revision()?;
        let data_revision = self
            .data_revision
            .checked_add(1)
            .ok_or("chart data revision exhausted")?;
        let state = InteractionState::from_ir(&source)
            .map_err(|error| format!("chart initialization: {error:?}"))?;
        let mut frame = ChartGeometryFrame::prepare(&source, &state, self.width, self.height)?;
        frame.set_revision(revision);
        self.source = Arc::new(source);
        self.state = state;
        self.frame = Arc::new(frame);
        self.revision = revision;
        self.data_revision = data_revision;
        Ok(())
    }
    fn next_revision(&self) -> Result<u64, String> {
        self.revision
            .checked_add(1)
            .ok_or_else(|| "chart revision exhausted".into())
    }
}

fn clear_hover(state: &mut InteractionState) {
    state.highlighted = None;
    state.tooltip = None;
}
