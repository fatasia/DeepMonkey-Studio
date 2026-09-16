use deep_engine_native::chart::ChartRuntime;
use deep_engine_native::chart::simulation::{ChartSimFixture, ChartSimulationSource};
use std::time::Instant;

/// 时钟与订阅归属于内容；换包直接销毁，设备恢复保留已提交的位置。
pub struct ChartSimHost {
    pub source: ChartSimulationSource,
    pub started: Option<Instant>,
    pub wake_at: Option<Instant>,
    pub last_error: Option<String>,
    pub committed_frames: u64,
}

impl ChartSimHost {
    pub fn new(fixture: ChartSimFixture, chart: &ChartRuntime) -> Result<Self, String> {
        Ok(Self {
            source: ChartSimulationSource::new(fixture, chart)?,
            started: None,
            wake_at: None,
            last_error: None,
            committed_frames: 0,
        })
    }
}
